// Kite's own pages, drawn by the interface itself (not loaded in a tab), so
// they're the same in the Kite app and Kite Web:
//   new tab      kite://newtab     search box and shortcuts
//   history      kite://history    Ctrl+H
//   bookmarks    kite://bookmarks  Ctrl+Shift+O
//   settings     kite://settings
// Everything shown from your data is set as text, never as HTML.

import * as D from "./lib/data.js";
import { SEARCH_ENGINES } from "./lib/omnibox.js";

export const PAGES = {
  newtab: "New Tab",
  history: "History",
  bookmarks: "Bookmarks",
  settings: "Settings",
};

// "kite://history" -> "history"; anything else -> null.
export function pageOf(url) {
  const m = /^kite:\/\/([a-z]+)\/?$/i.exec(String(url || "").trim());
  return m && PAGES[m[1].toLowerCase()] ? m[1].toLowerCase() : null;
}

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// A site's icon: its favicon where the platform shows them, else a letter tile.
function icon(url, ctx, big = false) {
  const host = hostOf(url);
  let hue = 0;
  for (const c of host) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const tile = el("span", { className: "tile" + (big ? " big" : ""), textContent: (host[0] || "?").toUpperCase() });
  tile.style.background = `hsl(${hue} 45% 38%)`;
  if (!ctx.favicons) return tile;
  try {
    const img = el("img", { className: "favicon" + (big ? " big" : ""), src: new URL("/favicon.ico", url).href, alt: "", referrerPolicy: "no-referrer" });
    img.onerror = () => img.replaceWith(tile);
    return img;
  } catch {
    return tile;
  }
}

// A link that opens in this tab, or a new one with Ctrl/middle click.
function link(url, text, ctx, className = "") {
  const a = el("a", { href: url, textContent: text ?? url, className }); // "" = no text (icon tiles)
  a.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.open(url, { newTab: e.ctrlKey || e.metaKey || e.shiftKey });
  });
  a.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    ctx.open(url, { newTab: true });
  });
  return a;
}

function confirmButton(label, sure, onConfirm) {
  const b = el("button", { type: "button", textContent: label });
  b.addEventListener("click", () => {
    if (!b.dataset.sure) {
      b.dataset.sure = "1";
      b.textContent = sure;
      setTimeout(() => {
        delete b.dataset.sure;
        b.textContent = label;
      }, 4000);
      return;
    }
    onConfirm();
  });
  return b;
}

// ---------- new tab ----------

function newTab(root, ctx) {
  const { store } = ctx;
  const q = el("input", { id: "ntp-search", type: "text", autocomplete: "off", spellcheck: false, placeholder: `Search ${SEARCH_ENGINES[store.get("settings").searchEngine]?.name || "the web"} or type an address` });
  const form = el("form", { className: "ntp-search" }, q);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (q.value.trim()) ctx.navigate(q.value);
  });
  const grid = el("div", { className: "ntp-grid" });
  const adder = el("form", { className: "ntp-add", hidden: true });
  const name = el("input", { placeholder: "Name", maxLength: 60 });
  const url = el("input", { placeholder: "Address (https://...)", spellcheck: false });
  adder.append(name, url, el("button", { type: "submit", textContent: "Add" }), el("button", { type: "button", textContent: "Cancel", onclick: () => (adder.hidden = true) }));
  adder.addEventListener("submit", (e) => {
    e.preventDefault();
    let u = url.value.trim();
    if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(u)) return url.focus();
    store.set("shortcuts", D.addShortcut(store.get("shortcuts"), store.get("history"), { url: u, title: name.value.trim() || hostOf(u) }));
    adder.hidden = true;
  });
  function draw() {
    grid.textContent = "";
    for (const s of D.newTabShortcuts(store.get("shortcuts"), store.get("history"))) {
      const remove = el("button", { type: "button", className: "x", title: "Remove", textContent: "×" });
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        store.set("shortcuts", D.removeShortcut(store.get("shortcuts"), store.get("history"), s.url));
      });
      const a = link(s.url, "", ctx, "ntp-tile");
      a.append(icon(s.url, ctx, true), el("span", { className: "label", textContent: s.title || hostOf(s.url) }), remove);
      grid.append(a);
    }
    const add = el("button", { type: "button", className: "ntp-tile add" }, el("span", { className: "tile big plus", textContent: "+" }), el("span", { className: "label", textContent: "Add shortcut" }));
    add.addEventListener("click", () => {
      adder.hidden = false;
      name.value = url.value = "";
      name.focus();
    });
    grid.append(add);
  }
  draw();
  root.append(el("div", { className: "ntp" }, el("h1", { className: "ntp-logo", textContent: "Kite" }), form, grid, adder));
  return { refresh: (n) => (n === "shortcuts" || n === "history" ? draw() : null) };
}

// ---------- history ----------

function history(root, ctx) {
  const { store } = ctx;
  const search = el("input", { type: "search", placeholder: "Search history", spellcheck: false });
  const list = el("div", { className: "kp-list" });
  let shown = 300;
  function draw() {
    list.textContent = "";
    const all = D.searchHistory(store.get("history"), search.value);
    if (!store.get("settings").recordHistory) list.append(el("p", { className: "muted", textContent: "History is turned off in Settings." }));
    if (!all.length) list.append(el("p", { className: "muted", textContent: search.value ? "No matches." : "Pages you visit appear here." }));
    let day = null;
    for (const v of all.slice(0, shown)) {
      const label = D.dayLabel(v.time);
      if (label !== day) list.append(el("h3", { textContent: (day = label) }));
      const remove = el("button", { type: "button", className: "x", title: "Remove from history", textContent: "×" });
      remove.addEventListener("click", () => store.update("history", (h) => D.removeVisits(h, [v.time])));
      list.append(
        el("div", { className: "kp-row" },
          el("span", { className: "time", textContent: new Date(v.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
          icon(v.url, ctx),
          link(v.url, v.title || v.url, ctx, "title"),
          el("span", { className: "host", textContent: hostOf(v.url) }),
          remove)
      );
    }
    if (all.length > shown) {
      list.append(el("button", { type: "button", className: "more", textContent: `Show more (${all.length - shown})`, onclick: () => ((shown += 300), draw()) }));
    }
  }
  search.addEventListener("input", () => ((shown = 300), draw()));
  const clear = confirmButton("Clear browsing history", "Clear all of it? Click again", () => store.set("history", []));
  root.append(el("div", { className: "kp" }, el("div", { className: "kp-head" }, el("h1", { textContent: "History" }), search, clear), list));
  draw();
  return { refresh: (n) => (n === "history" || n === "settings" ? draw() : null), focus: () => search.focus() };
}

// ---------- bookmarks ----------

function bookmarks(root, ctx) {
  const { store } = ctx;
  const search = el("input", { type: "search", placeholder: "Search bookmarks", spellcheck: false });
  const list = el("div", { className: "kp-list" });
  let editing = null;
  function draw() {
    list.textContent = "";
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = store.get("bookmarks").filter((b) => words.every((w) => (b.title + " " + b.url).toLowerCase().includes(w)));
    if (!all.length) list.append(el("p", { className: "muted", textContent: search.value ? "No matches." : "Bookmark a page with the ☆ in the address bar, or Ctrl+D." }));
    for (const b of all) {
      if (editing === b.id) {
        const title = el("input", { value: b.title, maxLength: 300 });
        const url = el("input", { value: b.url, spellcheck: false });
        const save = el("button", { type: "submit", textContent: "Save" });
        const form = el("form", { className: "kp-row edit" }, title, url, save, el("button", { type: "button", textContent: "Cancel", onclick: () => ((editing = null), draw()) }));
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          editing = null;
          store.update("bookmarks", (list) => D.updateBookmark(list, b.id, { title: title.value.trim(), url: url.value.trim() }));
        });
        list.append(form);
        title.focus();
        continue;
      }
      const btn = (label, title, fn) => el("button", { type: "button", textContent: label, title, onclick: fn });
      list.append(
        el("div", { className: "kp-row" },
          icon(b.url, ctx),
          link(b.url, b.title, ctx, "title"),
          el("span", { className: "host", textContent: hostOf(b.url) }),
          btn("↑", "Move up", () => store.update("bookmarks", (l) => D.moveBookmark(l, b.id, -1))),
          btn("↓", "Move down", () => store.update("bookmarks", (l) => D.moveBookmark(l, b.id, 1))),
          btn("Edit", "Edit", () => ((editing = b.id), draw())),
          btn("Delete", "Delete", () => store.update("bookmarks", (l) => D.removeBookmark(l, b.id))))
      );
    }
  }
  search.addEventListener("input", draw);
  root.append(el("div", { className: "kp" }, el("div", { className: "kp-head" }, el("h1", { textContent: "Bookmarks" }), search), list));
  draw();
  return { refresh: (n) => (n === "bookmarks" ? draw() : null), focus: () => search.focus() };
}

// ---------- settings ----------

function settings(root, ctx) {
  const { store } = ctx;
  const s = () => store.get("settings");
  const change = (key, value) => store.set("settings", { ...s(), [key]: value });
  const section = (title, ...rows) => el("section", {}, el("h2", { textContent: title }), ...rows);
  const row = (label, control, hint) => el("label", { className: "set-row" }, el("span", {}, el("span", { textContent: label }), hint ? el("small", { textContent: hint }) : null), control);
  const check = (key) => {
    const c = el("input", { type: "checkbox", checked: Boolean(s()[key]) });
    c.addEventListener("change", () => change(key, c.checked));
    return c;
  };

  const engine = el("select", {});
  for (const [id, e] of Object.entries(SEARCH_ENGINES)) engine.append(el("option", { value: id, textContent: e.name, selected: s().searchEngine === id }));
  engine.addEventListener("change", () => change("searchEngine", engine.value));

  const startup = el("select", {});
  for (const [v, label] of [["newtab", "Open the new tab page"], ["continue", "Continue where you left off"], ["home", "Open the home page"]]) {
    startup.append(el("option", { value: v, textContent: label, selected: s().startup === v }));
  }
  startup.addEventListener("change", () => change("startup", startup.value));

  const home = el("input", { value: s().homePage, placeholder: "The new tab page", spellcheck: false });
  home.addEventListener("change", () => {
    let u = home.value.trim();
    if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
    home.value = u;
    change("homePage", u);
  });

  const clearHistory = confirmButton("Clear browsing history", "Clear all of it? Click again", () => store.set("history", []));
  const syncBox = ctx.sync ? el("div", {}) : null;
  if (syncBox) drawSync(syncBox, ctx.sync);
  root.append(
    el("div", { className: "kp settings" },
      el("div", { className: "kp-head" }, el("h1", { textContent: "Settings" })),
      section("Search", row("Search engine used in the address bar", engine)),
      section("On startup", row("When Kite starts", startup)),
      section("Appearance",
        row("Show home button", check("showHomeButton")),
        row("Home page", home, "Leave empty to use the new tab page."),
        row("Show bookmarks bar", check("showBookmarksBar"), "Ctrl+Shift+B")),
      section("Privacy",
        row("Keep browsing history", check("recordHistory")),
        el("div", { className: "set-row" }, el("span", { textContent: "History" }), clearHistory),
        ctx.platformName === "app"
          ? el("p", { className: "muted", textContent: "Cookies and site data are per profile: use the padlock in the address bar to clear one site's, or a guest window (Ctrl+Shift+N) to leave nothing behind." })
          : el("p", { className: "muted", textContent: "Kite Web keeps history, bookmarks and settings in this browser." })),
      syncBox ? section("Sync with a Kite account", syncBox) : null,
      ctx.hasProfiles ? section("Profiles", el("div", { className: "set-row" }, el("span", { textContent: "Profiles have their own history, bookmarks, logins and settings." }), el("button", { type: "button", textContent: "Manage profiles", onclick: () => ctx.action("profiles") }))) : null,
      section("About Kite", el("p", { className: "muted", textContent: `Kite ${ctx.platformName === "app" ? "app" : "Web"} • a browser of your own.` })))
  );
  return { refresh: () => null };
}

// The app: link this profile to a Kite account (with a code from Kite Web),
// then its history, bookmarks, shortcuts and settings sync with it.
async function drawSync(box, sync) {
  const st = await sync.status();
  box.textContent = "";
  if (st.unavailable) {
    box.append(el("p", { className: "muted", textContent: "Guest windows don't sync." }));
    return;
  }
  if (st.linked) {
    const when = st.lastSync ? new Date(st.lastSync).toLocaleString() : "not yet";
    const msg = el("p", { className: "muted", textContent: st.error || `Last synced: ${when}` });
    box.append(
      el("div", { className: "set-row" },
        el("span", {}, el("span", { textContent: `Synced with ${st.user}` }), el("small", { textContent: st.backend })),
        el("span", { className: "row" },
          el("button", { type: "button", textContent: "Sync now", onclick: async () => ((msg.textContent = "Syncing…"), await sync.now(), drawSync(box, sync)) }),
          confirmButton("Unlink", "Unlink this profile? Click again", async () => (await sync.unlink(), drawSync(box, sync))))),
      msg
    );
    return;
  }
  const backend = el("input", { placeholder: "Kite address, e.g. https://kite-api.example.com", spellcheck: false });
  const code = el("input", { placeholder: "Code, e.g. ABCD-2345", spellcheck: false, maxLength: 12 });
  const msg = el("p", { className: "muted", textContent: st.error || "In Kite Web, sign in to your Kite account, open the account panel (\u{1F464}) and click “Link the Kite app”. It shows the address and a code to enter here." });
  const form = el("form", { className: "set-row sync-form" }, backend, code, el("button", { type: "submit", textContent: "Link" }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "Linking…";
    const r = await sync.link(backend.value.trim(), code.value.trim());
    if (r && r.error) msg.textContent = r.error;
    else drawSync(box, sync);
  });
  box.append(form, msg);
}

const RENDER = { newtab: newTab, history, bookmarks, settings };

// Draw page `name` into `root`. ctx: { store, open(url, { newTab }), navigate(input),
// action(name), favicons, hasProfiles, platformName }. Returns { refresh(name), focus() }.
export function renderPage(name, root, ctx) {
  root.textContent = "";
  root.dataset.page = name;
  return RENDER[name](root, ctx);
}
