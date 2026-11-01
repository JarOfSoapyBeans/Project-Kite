// Kite, the browser app (Stage 7). Electron's main process.
//
// Each window shows Kite's shared interface (tabs, toolbar, address bar) from
// kite://app/, and belongs to one profile (its own cookies, logins, storage and
// site permissions). Each tab is a real Chromium page (a WebContentsView) placed
// under the toolbar: websites load directly, exactly as in Chrome or Edge.
//
// The interface talks to this file through preload.js (window.kiteDesktop) and
// gets events back on "kite:event" (see sendEvent calls below):
//   page        a tab's address, title, loading state, security
//   open        a page wants a new tab        search    "Search for ..." from a menu
//   shortcut    a key pressed inside a page   navigate  the new tab page's search box
//   find        find-in-page results          zoom      a tab's zoom level
//   permission  a site asks (camera...)       permission-done   that question went away
//   downloads   the download list changed

const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const {
  app, BrowserWindow, WebContentsView, ipcMain, protocol, net, session, Menu, shell, clipboard, dialog,
} = require("electron");
const { Profiles } = require("./lib/profiles.js");
const { SitePermissions, attachPermissions, originOf } = require("./lib/permissions.js");
const { Downloads } = require("./lib/downloads.js");
const { Sync } = require("./lib/sync.js");
const { pageMenu, tabMenu, appMenu } = require("./lib/menus.js");
const { DevtoolsLog, watchSession, consoleMessage } = require("./lib/devtools-log.js");

const UI_DIR = path.join(__dirname, "app-ui");
const UI_URL = "kite://app/index.html";
const NEW_TAB_URL = "kite://app/newtab.html";
const ERROR_URL = "kite://app/error.html";
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// Present as plain Chrome: sites (Google sign-in in particular) treat a browser
// that names itself "Electron" as an embedded app.
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/[^ ]+/, "")
  .replace(new RegExp(` ${app.getName()}/[^ ]+`, "i"), "")
  .replace(/ kite-desktop\/[^ ]+/i, "");

protocol.registerSchemesAsPrivileged([
  { scheme: "kite", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ---------- kite://app/ : Kite's own pages ----------

function serveKite(request) {
  const u = new URL(request.url);
  if (u.host !== "app") return new Response("Not found", { status: 404 });
  const file = path.normalize(path.join(UI_DIR, decodeURIComponent(u.pathname)));
  if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

// ---------- which addresses may load ----------

// What you can open from the address bar: websites, Kite's new tab page,
// view-source: of a website. Not file:, javascript:, chrome:, devtools:...
function allowedUrl(url) {
  try {
    const s = String(url);
    if (/^view-source:/i.test(s)) return /^https?:$/.test(new URL(s.slice(12)).protocol);
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return true;
    return u.href === NEW_TAB_URL || u.href === "about:blank";
  } catch {
    return false;
  }
}

// Where a page may send its own tab: websites; Kite's pages only from Kite's pages.
function pageMayGo(from, to) {
  if (/^(https?):/i.test(to)) return true;
  return /^kite:\/\/app\//.test(to) && /^kite:\/\/app\//.test(String(from));
}

// What the address bar's padlock shows.
function securityOf(url) {
  const s = String(url || "").replace(/^view-source:/i, "");
  if (s.startsWith("https:")) return "secure";
  if (s.startsWith("http:")) return "insecure";
  return "kite";
}

// ---------- keyboard shortcuts pressed inside a page ----------

function shortcutFor(input) {
  if (input.type !== "keyDown") return null;
  const mod = input.control || input.meta;
  const key = String(input.key || "").toLowerCase();
  if (mod && input.shift && key === "tab") return "prev-tab";
  if (mod && key === "tab") return "next-tab";
  if (mod && input.shift && key === "t") return "reopen-tab";
  if (mod && input.shift && key === "n") return "guest-window";
  if (mod && input.shift && key === "b") return "bookmarks-bar";
  if (mod && input.shift && key === "o") return "bookmarks";
  if (mod && input.shift && key === "k") return "kite-devtools";
  if (mod && key === "t") return "new-tab";
  if (mod && key === "n") return "new-window";
  if (mod && key === "w") return "close-tab";
  if (mod && key === "l") return "focus-address";
  if (mod && key === "f") return "find";
  if (mod && key === "p") return "print";
  if (mod && key === "j") return "downloads";
  if (mod && key === "h") return "history";
  if (mod && key === "d") return "bookmark";
  if (input.alt && key === "home") return "home";
  if (mod && (key === "=" || key === "+")) return "zoom-in";
  if (mod && key === "-") return "zoom-out";
  if (mod && key === "0") return "zoom-reset";
  if ((mod && key === "r") || key === "f5") return "reload";
  if (input.alt && key === "arrowleft") return "back";
  if (input.alt && key === "arrowright") return "forward";
  if (key === "f12" || (mod && input.shift && key === "i")) return "devtools";
  return null;
}

// ---------- profiles and their sessions ----------

let profiles = null; // Profiles (lib/profiles.js)
let downloads = null; // Downloads (lib/downloads.js)
const permsByProfile = new Map(); // profile id -> SitePermissions
const readySessions = new Set();
const windows = new Set(); // KiteWindow
const devlog = new DevtoolsLog(); // for kite://devtools

function withPartition(profile) {
  return { ...profile, partition: profile.guest ? profile.id : profiles.partitionFor(profile.id) };
}

function permsFor(profile) {
  if (!permsByProfile.has(profile.id)) {
    permsByProfile.set(profile.id, new SitePermissions(profile.guest ? null : app.getPath("userData"), profile.id));
  }
  return permsByProfile.get(profile.id);
}

function sessionFor(profile) {
  const ses = session.fromPartition(profile.partition);
  if (readySessions.has(profile.partition)) return ses;
  readySessions.add(profile.partition);
  ses.protocol.handle("kite", serveKite); // the new tab page and error page, inside tabs
  attachPermissions(ses, permsFor(profile), askPermission);
  downloads.attach(ses, profile.id);
  watchSession(ses, devlog, profile.id, tabOfContents);
  return ses;
}

// Which tab a page belongs to (by its webContents id), for Kite DevTools.
function tabOfContents(webContentsId) {
  for (const kw of windows) for (const [tabId, view] of kw.views) if (view.webContents.id === webContentsId) return { tabId };
  return null;
}

// A site asked for a permission: ask in the window showing it.
let nextRequest = 1;
const pendingRequests = new Map(); // request id -> { kw, tabId, resolve }
function askPermission({ webContents, origin, text }) {
  const owner = ownerOf(webContents);
  if (!owner) return { allow: false };
  return new Promise((resolve) => {
    const id = nextRequest++;
    pendingRequests.set(id, { kw: owner.kw, tabId: owner.id, origin, text, resolve });
    devlog.add(owner.kw.profile.id, "permission", { tab: owner.id, origin, text, answer: "asked" });
    owner.kw.send({ type: "permission", request: { id, tabId: owner.id, origin, text } });
  });
}
function finishRequest(id, answer) {
  const r = pendingRequests.get(id);
  if (!r) return;
  pendingRequests.delete(id);
  devlog.add(r.kw.profile.id, "permission", { tab: r.tabId, origin: r.origin, text: r.text, answer: answer.allow ? "allowed" : "blocked", remember: Boolean(answer.remember) });
  r.kw.send({ type: "permission-done", id });
  r.resolve(answer);
}
// A tab closed or left the page: its questions are answered "no".
function dropRequests(kw, tabId) {
  for (const [id, r] of pendingRequests) if (r.kw === kw && (tabId === undefined || r.tabId === tabId)) finishRequest(id, { allow: false });
}

function ownerOf(webContents) {
  for (const kw of windows) {
    const id = kw.idOf(webContents);
    if (id !== null) return { kw, id };
  }
  return null;
}

// ---------- a Kite window ----------

class KiteWindow {
  constructor(profile, startUrls = []) {
    this.profile = withPartition(profile);
    this.views = new Map(); // tab id -> WebContentsView
    this.failed = new Map(); // tab id -> { url, code, description } for error pages
    this.inset = 80; // height of Kite's toolbar, reported by the interface
    this.fullscreenId = null;
    this.activeId = null;
    this.startUrls = startUrls.filter(allowedUrl);
    this.ses = sessionFor(this.profile);

    const win = (this.win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 480,
      minHeight: 320,
      title: this.title(),
      backgroundColor: "#16181d",
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    }));
    windows.add(this);
    // Kite's own interface never navigates away or opens windows.
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("page-title-updated", (e) => e.preventDefault()); // keep "Kite (Profile)"
    win.on("resize", () => this.layout());
    win.on("enter-full-screen", () => this.layout());
    win.on("leave-full-screen", () => this.layout());
    win.on("closed", () => {
      dropRequests(this);
      windows.delete(this);
      this.views.clear();
      if (this.profile.guest && ![...windows].some((w) => w.profile.id === this.profile.id)) {
        this.ses.clearStorageData().catch(() => {}); // a guest leaves nothing behind
        permsByProfile.delete(this.profile.id);
        guestData.delete(this.profile.id);
        devlog.forget(this.profile.id);
      }
    });
    win.loadURL(UI_URL);
  }

  title() {
    const p = this.profile;
    return p.guest ? "Kite (Guest)" : p.id === "main" ? "Kite" : `Kite (${p.name})`;
  }

  send(event) {
    if (!this.win.isDestroyed()) this.win.webContents.send("kite:event", event);
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    for (const [id, view] of this.views) {
      if (id === this.fullscreenId) view.setBounds({ x: 0, y: 0, width, height });
      else view.setBounds({ x: 0, y: this.inset, width, height: Math.max(0, height - this.inset) });
    }
  }

  idOf(webContents) {
    for (const [id, view] of this.views) if (view.webContents === webContents) return id;
    return null;
  }

  report(id, info) {
    if ("url" in info) {
      const url = String(info.url || "");
      if (url === NEW_TAB_URL) info = { ...info, url: null, title: "New Tab", security: "kite" };
      else if (url.startsWith(ERROR_URL)) {
        const f = this.failed.get(id);
        info = { ...info, url: f ? f.url : null, security: "error" };
      } else info = { ...info, security: securityOf(url) };
    }
    this.send({ type: "page", id, info });
  }

  reportZoom(id) {
    const view = this.views.get(id);
    if (view) this.send({ type: "zoom", id, percent: Math.round(view.webContents.getZoomFactor() * 100) });
  }

  createView(id) {
    if (this.views.has(id)) return;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.profile.partition,
        preload: path.join(__dirname, "view-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
      },
    });
    const wc = view.webContents;
    this.views.set(id, view);
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.layout();

    wc.on("did-start-loading", () => this.report(id, { loading: true }));
    wc.on("did-stop-loading", () => this.report(id, { loading: false, url: wc.getURL(), title: wc.getTitle() }));
    wc.on("page-title-updated", (_e, title) => this.report(id, { title }));
    wc.on("did-navigate", (_e, url) => {
      if (!String(url).startsWith(ERROR_URL)) this.failed.delete(id);
      dropRequests(this, id);
      this.report(id, { url });
      this.reportZoom(id);
    });
    // Pages' warnings and errors (everything else stays in F12's console).
    wc.on("console-message", (...args) => {
      const m = consoleMessage(args);
      if (m.level === "log") return;
      const where = m.source ? ` (${String(m.source).slice(0, 300)}${m.line ? ":" + m.line : ""})` : "";
      devlog.add(this.profile.id, "log", { level: m.level, tab: id, text: `[page ${m.level === "error" ? "error" : "warning"}] ${m.text.slice(0, 3000)}${where}` });
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => isMainFrame && this.report(id, { url }));
    // Pages that can't load show Kite's error page (the address bar keeps the address).
    wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || String(url).startsWith("kite:")) return; // -3: cancelled, e.g. a new navigation
      this.failed.set(id, { url, code, description });
      devlog.add(this.profile.id, "log", { level: "error", tab: id, text: `[page didn't load] ${url}: ${description} (${code})` });
      const q = new URLSearchParams({ u: url, c: String(code), d: String(description || "") });
      wc.loadURL(`${ERROR_URL}?${q}`).catch(() => {});
    });
    wc.on("render-process-gone", (_e, details) => {
      devlog.add(this.profile.id, "log", { level: "error", tab: id, text: `[PAGE CRASH] ${wc.getURL()}: ${details.reason} (exit code ${details.exitCode})` });
      this.report(id, { loading: false, title: `Page crashed (${details.reason})` });
    });
    wc.on("found-in-page", (_e, r) => {
      if (r.finalUpdate !== false) this.send({ type: "find", id, active: r.activeMatchOrdinal || 0, total: r.matches || 0 });
    });
    wc.on("zoom-changed", (_e, direction) => this.zoom(id, direction)); // Ctrl + mouse wheel

    // Links and window.open: a new tab, or a real pop-up window for pages that
    // ask for one (sign-in windows like "Sign in with Google" need their opener).
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!allowedUrl(url) || /^view-source:/i.test(url)) return { action: "deny" };
      if (disposition === "new-window") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 520,
            height: 700,
            autoHideMenuBar: true,
            webPreferences: { partition: this.profile.partition, contextIsolation: true, sandbox: true, nodeIntegration: false },
          },
        };
      }
      this.send({ type: "open", url });
      return { action: "deny" };
    });
    // Pages can't send a tab somewhere unsafe (file:, chrome:, Kite's own pages...).
    wc.on("will-navigate", (e, url) => {
      if (!pageMayGo(wc.getURL(), url)) e.preventDefault();
    });

    wc.on("before-input-event", (event, input) => {
      const name = shortcutFor(input);
      if (!name) return;
      event.preventDefault();
      if (!this.windowShortcut(name, id)) {
        if (["focus-address", "new-tab", "find", "bookmark"].includes(name)) this.win.webContents.focus();
        this.send({ type: "shortcut", name });
      }
    });

    wc.on("context-menu", (_e, params) => {
      const nav = wc.navigationHistory || wc;
      const items = pageMenu(params, { canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward(), searchName: "the web" }, (a, v) =>
        this.pageAction(id, a, v)
      );
      Menu.buildFromTemplate(items).popup({ window: this.win });
    });

    // Fullscreen video fills the whole window.
    wc.on("enter-html-full-screen", () => {
      this.fullscreenId = id;
      this.win.setFullScreen(true);
      this.layout();
    });
    wc.on("leave-html-full-screen", () => {
      this.fullscreenId = null;
      this.win.setFullScreen(false);
      this.layout();
    });
  }

  // Shortcuts that act on windows, not on this window's interface.
  windowShortcut(name, id) {
    if (name === "devtools") {
      const v = this.views.get(id);
      if (v) v.webContents.toggleDevTools();
      return true;
    }
    if (name === "new-window") return new KiteWindow(this.profile), true;
    if (name === "guest-window") return new KiteWindow(profiles.guest()), true;
    return false;
  }

  pageAction(id, action, value) {
    const view = this.views.get(id);
    if (!view) return;
    const wc = view.webContents;
    switch (action) {
      case "open-tab": return this.send({ type: "open", url: value });
      case "open-window": return new KiteWindow(this.profile, [value]);
      case "search": return this.send({ type: "search", text: value });
      case "download": return wc.downloadURL(value);
      case "copy": return clipboard.writeText(String(value));
      case "copy-image": return wc.copyImageAt(value.x, value.y);
      case "view-source": return this.send({ type: "open", url: "view-source:" + value });
      case "inspect": return wc.inspectElement(value.x, value.y);
      case "replace-misspelling": return wc.replaceMisspelling(value);
      case "add-to-dictionary": return wc.session.addWordToSpellCheckerDictionary(value);
      case "pdf": return this.savePdf(id);
      default: return this.command(id, action); // back, forward, reload, print
    }
  }

  closeView(id) {
    const view = this.views.get(id);
    if (!view) return;
    dropRequests(this, id);
    this.views.delete(id);
    this.failed.delete(id);
    if (this.fullscreenId === id) this.fullscreenId = null;
    this.win.contentView.removeChildView(view);
    view.webContents.close();
  }

  showView(id) {
    this.activeId = id;
    for (const [vid, view] of this.views) view.setVisible(vid === id);
  }

  command(id, cmd) {
    const view = this.views.get(id);
    if (!view) return;
    const wc = view.webContents;
    const nav = wc.navigationHistory || wc; // navigationHistory: Electron 32+
    if (cmd === "back" && nav.canGoBack()) nav.goBack();
    else if (cmd === "forward" && nav.canGoForward()) nav.goForward();
    else if (cmd === "reload") {
      const f = this.failed.get(id);
      if (f && String(wc.getURL()).startsWith(ERROR_URL)) wc.loadURL(f.url).catch(() => {});
      else wc.reload();
    } else if (cmd === "stop") wc.stop();
    else if (cmd === "print") wc.print({}, () => {});
  }

  navigate(id, url) {
    const view = this.views.get(id);
    if (!view || !allowedUrl(url)) return false;
    view.webContents.loadURL(url).catch(() => {}); // failures show Kite's error page
    return true;
  }

  find(id, text, opts = {}) {
    const view = this.views.get(id);
    if (!view) return;
    text = String(text || "");
    if (!text) return view.webContents.stopFindInPage("clearSelection");
    view.webContents.findInPage(text, { forward: opts.forward !== false, findNext: Boolean(opts.findNext), matchCase: Boolean(opts.matchCase) });
  }

  stopFind(id) {
    const view = this.views.get(id);
    if (view) view.webContents.stopFindInPage("clearSelection");
  }

  zoom(id, direction) {
    const view = this.views.get(id);
    if (!view) return;
    const wc = view.webContents;
    const now = wc.getZoomFactor();
    let next = 1;
    if (direction === "in") next = ZOOMS.find((z) => z > now + 0.001) || ZOOMS[ZOOMS.length - 1];
    else if (direction === "out") next = [...ZOOMS].reverse().find((z) => z < now - 0.001) || ZOOMS[0];
    wc.setZoomFactor(next);
    this.reportZoom(id);
  }

  async savePdf(id) {
    const view = this.views.get(id);
    if (!view) return false;
    const wc = view.webContents;
    const name = (String(wc.getTitle() || "page").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "page").slice(0, 100) + ".pdf";
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      defaultPath: path.join(app.getPath("downloads"), name),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, await wc.printToPDF({ printBackground: true }));
    return true;
  }

  siteInfo(id) {
    const view = this.views.get(id);
    if (!view) return null;
    const url = view.webContents.getURL();
    const f = this.failed.get(id);
    const shown = url.startsWith(ERROR_URL) && f ? f.url : url;
    const origin = originOf(shown.replace(/^view-source:/i, ""));
    return {
      origin,
      security: url.startsWith(ERROR_URL) ? "error" : securityOf(url),
      permissions: origin ? permsFor(this.profile).forSite(origin) : {},
      profile: this.profile.name,
    };
  }

  async clearSite(id) {
    const info = this.siteInfo(id);
    if (!info || !info.origin) return false;
    permsFor(this.profile).reset(info.origin);
    await this.ses.clearStorageData({ origin: info.origin });
    return true;
  }

  // A real menu, resolving to the item picked (or null).
  popup(items) {
    return new Promise((resolve) => {
      const pick = (a) => resolve(a);
      Menu.buildFromTemplate(items(pick)).popup({ window: this.win, callback: () => setTimeout(() => resolve(null), 100) });
    });
  }
}

// ---------- history, bookmarks, settings... (per profile) ----------

// Saved by the interface (see shared/ui/store.js). Kept in
// <userData>/profile-data/<profile>/<name>.json; guests' only in memory.
const DATA_NAMES = new Set(["history", "bookmarks", "shortcuts", "settings", "session"]);
const MAX_DATA = 8 * 1024 * 1024;
const guestData = new Map(); // guest profile id -> Map(name -> value)

function dataFile(profileId, name) {
  return path.join(app.getPath("userData"), "profile-data", profileId, name + ".json");
}

// Writes happen in the background (history is saved every few seconds while you
// browse, and a big file written on this thread would freeze every window);
// reads see the newest value even before it reaches the disk.
const latest = new Map(); // file -> text waiting to be written (or being written)
const writing = new Set();

function readFile(profileId, name) {
  const file = dataFile(profileId, name);
  try {
    return JSON.parse(latest.has(file) ? latest.get(file) : fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeFile(profileId, name, value) {
  const file = dataFile(profileId, name);
  latest.set(file, JSON.stringify(value ?? null));
  if (!writing.has(file)) flushFile(file);
}

async function flushFile(file) {
  writing.add(file);
  try {
    while (latest.has(file)) {
      const text = latest.get(file);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file + ".tmp", text);
      await fs.promises.rename(file + ".tmp", file);
      if (latest.get(file) === text) latest.delete(file); // nothing newer arrived meanwhile
    }
  } catch (err) {
    console.warn(`[kite] couldn't save ${file}: ${err.message}`);
    latest.delete(file);
  } finally {
    writing.delete(file);
  }
}

// Before quitting: whatever is still waiting goes to disk now.
function flushAllFiles() {
  for (const [file, text] of latest) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    } catch {}
  }
  latest.clear();
}

// Tell a profile's windows (except one) that some of its data changed.
function dataChanged(profileId, name, value, except = null) {
  for (const w of windows) if (w !== except && w.profile.id === profileId) w.send({ type: "data", name, value });
}

function loadData(profile, name) {
  if (!DATA_NAMES.has(name)) return null;
  if (profile.guest) return (guestData.get(profile.id) || new Map()).get(name) ?? null;
  return readFile(profile.id, name);
}

function saveData(kw, name, value) {
  if (!DATA_NAMES.has(name)) return false;
  const text = JSON.stringify(value ?? null);
  if (text.length > MAX_DATA) return false;
  const profile = kw.profile;
  value = JSON.parse(text);
  if (profile.guest) {
    if (!guestData.has(profile.id)) guestData.set(profile.id, new Map());
    guestData.get(profile.id).set(name, value);
  } else {
    writeFile(profile.id, name, value);
    sync.noteChange(profile.id, name); // linked to a Kite account: send it soon
  }
  dataChanged(profile.id, name, value, kw); // the profile's other windows see the change
  return true;
}

// Syncing profiles with a Kite account (lib/sync.js). Guests never sync.
let sync = { noteChange() {} };

// ---------- the interface's requests ----------

// Only Kite's own interface (the top page of a Kite window) may drive the tabs.
function windowOf(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !String(frame.url).startsWith("kite://app/")) return null;
  for (const kw of windows) if (event.sender === kw.win.webContents) return kw;
  return null;
}

// Kite Search: the app asks a Kite backend for results. The profile's linked
// Kite account's backend if there is one, else KITE_SEARCH_SERVER, else the one
// this build of Kite comes with ("kite.searchServer" in package.json).
function searchServer(profile) {
  const linked = !profile.guest && sync.status && sync.status(profile.id).backend;
  if (linked) return linked;
  if (process.env.KITE_SEARCH_SERVER) return process.env.KITE_SEARCH_SERVER;
  try {
    return require("./package.json").kite.searchServer || null;
  } catch {
    return null;
  }
}
async function searchQuery(profile, q, page) {
  const server = searchServer(profile);
  if (!server) return { error: "No Kite backend to search with: link this profile to your Kite account in Settings." };
  let base;
  try {
    base = new URL(server);
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error();
  } catch {
    return { error: "The Kite Search address isn't a web address." };
  }
  const url = new URL("/__kite/search", base.origin);
  url.searchParams.set("q", String(q || "").slice(0, 300));
  url.searchParams.set("page", String(Math.max(1, Math.min(50, Number(page) || 1))));
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const answer = await r.json().catch(() => ({}));
    if (!r.ok) return { error: answer.error || `Kite Search answered ${r.status}.` };
    // Only what the results page uses, and only web addresses.
    const results = (Array.isArray(answer.results) ? answer.results : []).filter((x) => x && /^https?:\/\//i.test(String(x.url))).slice(0, 20).map((x) => ({
      url: String(x.url), title: String(x.title || "").slice(0, 300), host: String(x.host || ""),
      snippet: (Array.isArray(x.snippet) ? x.snippet : []).slice(0, 80).map((s) => ({ text: String(s && s.text || "").slice(0, 500), hit: Boolean(s && s.hit) })),
    }));
    return { results, total: Number(answer.total) || 0, took: Number(answer.took) || 0, pages: Number(answer.pages) || 0, query: String(answer.query || "") };
  } catch (err) {
    return { error: `Couldn't reach Kite Search at ${base.host}.` };
  }
}

// The app at a glance, for Kite DevTools.
function devtoolsStatus(kw) {
  let memory = null;
  try {
    const metrics = app.getAppMetrics ? app.getAppMetrics() : [];
    memory = { processes: metrics.length, kb: metrics.reduce((sum, m) => sum + ((m.memory && m.memory.workingSetSize) || 0), 0) };
  } catch {}
  const mine = [...windows].filter((w) => w.profile.id === kw.profile.id);
  return {
    app: app.getVersion ? app.getVersion() : null,
    versions: { electron: process.versions.electron || null, chrome: process.versions.chrome || null, node: process.versions.node },
    platform: `${process.platform} ${process.arch}`,
    uptime: Math.round((Date.now() - devlog.started) / 1000),
    profile: { id: kw.profile.id, name: kw.profile.name, guest: Boolean(kw.profile.guest) },
    windows: mine.length,
    tabs: mine.reduce((sum, w) => sum + w.views.size, 0),
    memory,
    sync: kw.profile.guest ? null : sync.status(kw.profile.id),
    downloads: downloads.list(kw.profile.id).length,
    events: devlog.events.filter((e) => e.profile === kw.profile.id).length,
  };
}

function openProfile(id) {
  const p = profiles.get(id);
  if (p) new KiteWindow(p);
}

function wireIpc() {
  const on = (name, fn) =>
    ipcMain.handle(name, (event, ...args) => {
      const kw = windowOf(event);
      if (!kw) throw new Error("not allowed");
      return fn(kw, ...args);
    });
  const n = Number;
  on("view:create", (kw, id) => kw.createView(n(id)));
  on("view:close", (kw, id) => kw.closeView(n(id)));
  on("view:show", (kw, id) => kw.showView(n(id)));
  on("view:navigate", (kw, id, url) => kw.navigate(n(id), String(url)));
  on("view:newtab", (kw, id) => kw.navigate(n(id), NEW_TAB_URL));
  on("view:command", (kw, id, cmd) => kw.command(n(id), String(cmd)));
  on("view:find", (kw, id, text, opts) => kw.find(n(id), text, opts || {}));
  on("view:stop-find", (kw, id) => kw.stopFind(n(id)));
  on("view:zoom", (kw, id, dir) => kw.zoom(n(id), String(dir)));
  on("view:pdf", (kw, id) => kw.savePdf(n(id)));
  on("view:devtools", (kw, id) => kw.windowShortcut("devtools", n(id)));
  on("site:info", (kw, id) => kw.siteInfo(n(id)));
  on("site:clear", (kw, id) => kw.clearSite(n(id)));
  on("site:reset-permissions", (kw, id) => {
    const info = kw.siteInfo(n(id));
    if (info && info.origin) permsFor(kw.profile).reset(info.origin);
    return kw.siteInfo(n(id));
  });
  on("permission:answer", (kw, reqId, allow, remember) => {
    const r = pendingRequests.get(n(reqId));
    if (r && r.kw === kw) finishRequest(n(reqId), { allow: Boolean(allow), remember: Boolean(remember) });
  });
  on("downloads:list", (kw) => downloads.list(kw.profile.id));
  on("downloads:action", (kw, id, cmd) => downloads.action(kw.profile.id, n(id), String(cmd)));
  on("profiles:list", (kw) => ({ list: profiles.list(), current: { id: kw.profile.id, name: kw.profile.name, guest: Boolean(kw.profile.guest) } }));
  on("profiles:add", (_kw, name) => {
    const p = profiles.add(name);
    new KiteWindow(p);
    return p;
  });
  on("profiles:rename", (_kw, id, name) => {
    const ok = profiles.rename(String(id), name);
    if (ok) for (const w of windows) if (w.profile.id === id) (w.profile.name = profiles.get(id).name), w.win.setTitle(w.title());
    return ok;
  });
  on("profiles:remove", async (kw, id) => {
    id = String(id);
    const p = profiles.get(id);
    if (!p || id === "main") return false;
    for (const w of [...windows]) if (w.profile.id === id) w.win.close();
    profiles.remove(id);
    await session.fromPartition(profiles.partitionFor(id)).clearStorageData().catch(() => {});
    permsByProfile.delete(id);
    fs.rmSync(path.join(app.getPath("userData"), `permissions-${id}.json`), { force: true });
    fs.rmSync(path.join(app.getPath("userData"), "profile-data", id), { recursive: true, force: true });
    await sync.unlink(id).catch(() => {});
    devlog.forget(id);
    return true;
  });
  on("profiles:open", (_kw, id) => openProfile(String(id)));
  on("window:new", (kw) => void new KiteWindow(kw.profile));
  on("window:guest", () => void new KiteWindow(profiles.guest()));
  on("ui:start-urls", (kw) => {
    const urls = kw.startUrls;
    kw.startUrls = [];
    return urls;
  });
  on("data:load", (kw, name) => loadData(kw.profile, String(name)));
  on("sync:status", (kw) => (kw.profile.guest ? { unavailable: true } : sync.status(kw.profile.id)));
  on("sync:link", (kw, backend, code) => (kw.profile.guest ? { error: "Guest windows don't sync." } : sync.link(kw.profile.id, String(backend), String(code))));
  on("sync:unlink", (kw) => (kw.profile.guest ? { unavailable: true } : sync.unlink(kw.profile.id)));
  on("sync:now", (kw) => (kw.profile.guest ? { unavailable: true } : sync.syncNow(kw.profile.id)));
  on("data:save", (kw, name, value) => saveData(kw, String(name), value));
  // Kite DevTools (kite://devtools): this window's profile only.
  on("devtools:events", (kw, since, limit) => devlog.since(kw.profile.id, n(since) || 0, Math.min(2000, n(limit) || 500)));
  on("devtools:clear", (kw) => devlog.clear(kw.profile.id));
  on("devtools:status", (kw) => devtoolsStatus(kw));
  on("search:query", (kw, q, page) => searchQuery(kw.profile, q, page));
  on("ui:inset", (kw, px) => {
    kw.inset = Math.max(0, Math.min(600, Math.round(n(px) || 0)));
    kw.layout();
  });
  on("ui:focus", (kw) => kw.win.webContents.focus());
  on("menu:tab", (kw, opts = {}) => kw.popup((pick) => tabMenu({ canReopen: Boolean(opts.canReopen), count: n(opts.count) || 1 }, pick)));
  on("menu:app", async (kw) => {
    const chosen = await kw.popup((pick) => appMenu({ profiles: profiles.list(), currentProfile: kw.profile.id }, pick));
    if (!chosen) return null;
    // Window-level choices are done here; the rest the interface does.
    if (chosen === "new-window") return new KiteWindow(kw.profile), null;
    if (chosen === "guest-window") return new KiteWindow(profiles.guest()), null;
    if (chosen.startsWith("open-profile:")) return openProfile(chosen.slice(13)), null;
    if (chosen === "devtools") return kw.windowShortcut("devtools", kw.activeId), null;
    if (chosen === "exit") return app.quit(), null;
    return chosen;
  });

  // The new tab page's search box (only Kite's own page may ask).
  ipcMain.on("newtab:navigate", (event, input) => {
    const owner = ownerOf(event.sender);
    if (!owner || event.sender.getURL() !== NEW_TAB_URL) return;
    owner.kw.send({ type: "navigate", id: owner.id, input: String(input).slice(0, 2000) });
  });
}

// ---------- starting up ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const kw = [...windows][0];
    if (!kw) return;
    if (kw.win.isMinimized()) kw.win.restore();
    kw.win.focus();
  });

  app.whenReady().then(() => {
    profiles = new Profiles(app.getPath("userData"));
    sync = new Sync({
      dir: app.getPath("userData"),
      read: readFile,
      write: writeFile,
      changed: (profileId, name, value) => dataChanged(profileId, name, value),
      synced: (profileId, r) => {
        if (r.error) devlog.add(profileId, "log", { level: "warn", text: `[sync] ${r.error}` });
        else if (r.sent.length || r.took.length)
          devlog.add(profileId, "log", { level: "log", text: `[sync] sent: ${r.sent.join(", ") || "nothing"}; received: ${r.took.join(", ") || "nothing"}` });
      },
    });
    for (const p of profiles.list()) {
      sync.start(p.id);
      if (sync.status(p.id).linked) sync.syncNow(p.id);
    }
    downloads = new Downloads({ dir: () => app.getPath("downloads"), shell });
    downloads.on("started", (profileId, d) => devlog.add(profileId, "log", { level: "log", text: `[download] ${d.filename} from ${d.url}` }));
    downloads.on("done", (profileId, d) =>
      devlog.add(profileId, "log", { level: d.state === "completed" ? "log" : "warn", text: `[download ${d.state}] ${d.filename} (${d.received} bytes)` })
    );
    downloads.on("changed", (profileId) => {
      for (const kw of windows) if (kw.profile.id === profileId) kw.send({ type: "downloads", list: downloads.list(profileId) });
    });
    protocol.handle("kite", serveKite); // the interface's own session
    // No default menu: its shortcuts (Ctrl+R, Ctrl+W) would act on Kite's own
    // interface instead of the page. macOS still needs one for copy and paste.
    Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]) : null);
    wireIpc();
    new KiteWindow(profiles.get("main"));
    app.on("activate", () => !windows.size && new KiteWindow(profiles.get("main")));
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    flushAllFiles();
    if (profiles) profiles.store.saveNow();
    for (const p of permsByProfile.values()) p.store.saveNow();
  });

  // Links Kite can't show (mailto:, other apps) go to the system.
  // Rules for every page Electron makes, including sites' pop-up windows (e.g.
  // "Sign in with Google"). Kite's own windows and tabs then set stricter ones.
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-attach-webview", (e) => e.preventDefault()); // no <webview> anywhere
    wc.on("will-navigate", (e, url) => {
      if (/^(mailto|tel|sms):/i.test(url)) {
        e.preventDefault();
        shell.openExternal(url);
      } else if (!/^(https?|about|kite|data|blob):/i.test(url)) e.preventDefault(); // file:, chrome:...
    });
    // A pop-up opening another window: websites only, sandboxed like the rest.
    wc.setWindowOpenHandler(({ url }) =>
      /^https?:\/\//i.test(url)
        ? { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } }
        : { action: "deny" }
    );
  });
}

module.exports = { allowedUrl, shortcutFor, pageMayGo, securityOf, windows }; // for tests
