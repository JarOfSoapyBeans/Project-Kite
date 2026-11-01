// Kite, the browser app (Stage 7). Electron's main process.
//
// One window shows Kite's shared interface (tabs, toolbar, address bar) from
// kite://app/. Each tab is a real Chromium page (a WebContentsView) placed
// under the toolbar: websites load directly, exactly as in Chrome or Edge, with
// no proxy and no rewriting.
//
// The interface talks to this file through preload.js (window.kiteDesktop):
//   view:create / view:close / view:show / view:navigate / view:newtab /
//   view:command (back, forward, reload, stop) / ui:inset (toolbar height) / ui:focus
// and gets events back on "kite:event":
//   { type: "page", id, info: { url, title, loading } }   a tab's page changed
//   { type: "open", url }                                  a page wants a new tab
//   { type: "shortcut", name }                             a key pressed inside a page
//   { type: "navigate", id, input }                        the new tab page's search box

const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, session, Menu, shell } = require("electron");

const UI_DIR = path.join(__dirname, "app-ui");
const UI_URL = "kite://app/index.html";
const NEW_TAB_URL = "kite://app/newtab.html";
const PARTITION = "persist:main"; // where sites' cookies and storage live (profiles: part 3)

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

// ---------- which addresses tabs may open ----------

// Websites, and Kite's own new tab page. Not file:, javascript:, chrome:, devtools:...
function allowedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return true;
    if (u.href === NEW_TAB_URL) return true;
    return u.href === "about:blank";
  } catch {
    return false;
  }
}

// ---------- keyboard shortcuts pressed inside a page ----------

function shortcutFor(input) {
  if (input.type !== "keyDown") return null;
  const mod = input.control || input.meta;
  const key = String(input.key || "").toLowerCase();
  if (mod && input.shift && key === "tab") return "prev-tab";
  if (mod && key === "tab") return "next-tab";
  if (mod && input.shift && key === "t") return "reopen-tab";
  if (mod && key === "t") return "new-tab";
  if (mod && key === "w") return "close-tab";
  if (mod && key === "l") return "focus-address";
  if ((mod && key === "r") || key === "f5") return "reload";
  if (input.alt && key === "arrowleft") return "back";
  if (input.alt && key === "arrowright") return "forward";
  if (key === "f12" || (mod && input.shift && key === "i")) return "devtools";
  return null;
}

// ---------- the window and its tabs ----------

let win = null;
const views = new Map(); // tab id -> WebContentsView
let activeId = null;
let inset = 80; // height of Kite's toolbar, reported by the interface
let fullscreenId = null; // a tab showing a video fullscreen

function send(event) {
  if (win && !win.isDestroyed()) win.webContents.send("kite:event", event);
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  for (const [id, view] of views) {
    if (id === fullscreenId) view.setBounds({ x: 0, y: 0, width, height });
    else view.setBounds({ x: 0, y: inset, width, height: Math.max(0, height - inset) });
  }
}

function idOf(webContents) {
  for (const [id, view] of views) if (view.webContents === webContents) return id;
  return null;
}

function reportPage(id, info) {
  // The new tab page has no address to show.
  if ("url" in info && info.url === NEW_TAB_URL) info = { ...info, url: null, title: "New Tab" };
  send({ type: "page", id, info });
}

function createView(id) {
  if (views.has(id)) return;
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "view-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  const wc = view.webContents;
  views.set(id, view);
  win.contentView.addChildView(view);
  view.setVisible(false);
  layout();

  wc.on("did-start-loading", () => reportPage(id, { loading: true }));
  wc.on("did-stop-loading", () => reportPage(id, { loading: false, url: wc.getURL(), title: wc.getTitle() }));
  wc.on("page-title-updated", (_e, title) => reportPage(id, { title }));
  wc.on("did-navigate", (_e, url) => reportPage(id, { url }));
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => isMainFrame && reportPage(id, { url }));
  wc.on("render-process-gone", (_e, details) => {
    reportPage(id, { loading: false, title: `Page crashed (${details.reason})` });
  });

  // Links and window.open: a new tab, or a real pop-up window for pages that
  // ask for one (sign-in windows like "Sign in with Google" need their opener).
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!allowedUrl(url)) return { action: "deny" };
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    send({ type: "open", url });
    return { action: "deny" };
  });
  // Pages can't send a tab somewhere unsafe (file:, chrome:...).
  wc.on("will-navigate", (e, url) => {
    if (!allowedUrl(url)) e.preventDefault();
  });

  wc.on("before-input-event", (event, input) => {
    const name = shortcutFor(input);
    if (!name) return;
    event.preventDefault();
    if (name === "devtools") return wc.toggleDevTools();
    if (name === "focus-address" || name === "new-tab") win.webContents.focus();
    send({ type: "shortcut", name });
  });

  // Fullscreen video fills the whole window.
  wc.on("enter-html-full-screen", () => {
    fullscreenId = id;
    win.setFullScreen(true);
    layout();
  });
  wc.on("leave-html-full-screen", () => {
    fullscreenId = null;
    win.setFullScreen(false);
    layout();
  });
}

function closeView(id) {
  const view = views.get(id);
  if (!view) return;
  views.delete(id);
  if (fullscreenId === id) fullscreenId = null;
  win.contentView.removeChildView(view);
  view.webContents.close();
}

function showView(id) {
  activeId = id;
  for (const [vid, view] of views) view.setVisible(vid === id);
}

function command(id, cmd) {
  const view = views.get(id);
  if (!view) return;
  const wc = view.webContents;
  const nav = wc.navigationHistory || wc; // navigationHistory: Electron 32+
  if (cmd === "back" && nav.canGoBack()) nav.goBack();
  else if (cmd === "forward" && nav.canGoForward()) nav.goForward();
  else if (cmd === "reload") wc.reload();
  else if (cmd === "stop") wc.stop();
}

function navigate(id, url) {
  const view = views.get(id);
  if (!view || !allowedUrl(url)) return false;
  view.webContents.loadURL(url).catch(() => {}); // errors show as the page's own error
  return true;
}

// Only Kite's own interface may drive the tabs.
function fromUi(event) {
  const frame = event.senderFrame;
  return Boolean(win && event.sender === win.webContents && frame && !frame.parent && String(frame.url).startsWith("kite://app/"));
}

function wireIpc() {
  const on = (name, fn) =>
    ipcMain.handle(name, (event, ...args) => {
      if (!fromUi(event)) throw new Error("not allowed");
      return fn(...args);
    });
  on("view:create", (id) => createView(Number(id)));
  on("view:close", (id) => closeView(Number(id)));
  on("view:show", (id) => showView(Number(id)));
  on("view:navigate", (id, url) => navigate(Number(id), String(url)));
  on("view:newtab", (id) => navigate(Number(id), NEW_TAB_URL));
  on("view:command", (id, cmd) => command(Number(id), String(cmd)));
  on("ui:inset", (px) => {
    inset = Math.max(0, Math.min(400, Math.round(Number(px) || 0)));
    layout();
  });
  on("ui:focus", () => win.webContents.focus());

  // The new tab page's search box (only Kite's own page may ask).
  ipcMain.on("newtab:navigate", (event, input) => {
    const id = idOf(event.sender);
    if (id === null || event.sender.getURL() !== NEW_TAB_URL) return;
    send({ type: "navigate", id, input: String(input).slice(0, 2000) });
  });
}

// Safe defaults until Kite asks you (part 3): sites get no camera, microphone,
// location or notifications; fullscreen and clipboard writes are fine.
function lockDownSession(ses) {
  const ok = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ok.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ok.has(permission));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 320,
    title: "Kite",
    backgroundColor: "#16181d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Kite's own interface never navigates away or opens windows.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("resize", layout);
  win.on("enter-full-screen", layout);
  win.on("leave-full-screen", layout);
  win.on("closed", () => {
    win = null;
    views.clear();
  });
  win.loadURL(UI_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    protocol.handle("kite", serveKite); // the interface's own session
    const tabs = session.fromPartition(PARTITION);
    tabs.protocol.handle("kite", serveKite); // the new tab page, inside tabs
    lockDownSession(tabs);
    // No default menu: its shortcuts (Ctrl+R, Ctrl+W) would act on Kite's own
    // interface instead of the page. macOS still needs one for copy and paste.
    Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]) : null);
    wireIpc();
    createWindow();
    app.on("activate", () => !win && createWindow());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Links Kite can't show (mailto:, other apps) go to the system.
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-navigate", (e, url) => {
      if (/^(mailto|tel|sms):/i.test(url)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
  });
}

module.exports = { allowedUrl, shortcutFor }; // for tests
