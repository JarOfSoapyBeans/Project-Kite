// Kite's browser interface: tabs, toolbar, address bar, bookmarks bar, and
// Kite's own pages. Shared by the Kite app (desktop) and Kite Web. Everything
// that depends on where Kite runs (how a tab shows a page, going back,
// reloading, where data is kept...) goes through the platform layer:
//   platform/web.js       Kite Web: each tab is an iframe through the Kite backend
//   platform/desktop.js   Kite app: each tab is a real browser view
// The build copies the right one to platform/index.js.

import platform from "./platform/index.js";
import { toUrl, displayUrl } from "./lib/omnibox.js";
import * as D from "./lib/data.js";
import { initFeatures } from "./features.js";
import { openStore } from "./store.js";
import { PAGES, pageOf, renderPage } from "./pages.js";

const tabsEl = document.getElementById("tabs");
const addressEl = document.getElementById("address");
const statusEl = document.getElementById("status");
const internalEl = document.getElementById("internal");
const starEl = document.getElementById("star");
const barEl = document.getElementById("bookmarks-bar");

// tab: { id, url, title, loading, security, page, viewUrl, tabEl, labelEl }
//   page     one of Kite's own pages shown in this tab ("history"...), or null
//   viewUrl  the website the tab's real page is on (kept while a Kite page shows)
const tabs = [];
let activeTab = null;
let nextId = 1;

// Show only the buttons and panels this platform has (data-feature="...").
for (const el of document.querySelectorAll("[data-feature]")) {
  el.hidden = !platform.features[el.dataset.feature];
}

const store = await openStore(platform);
const settings = () => store.get("settings");
const isWeb = (url) => /^https?:\/\//i.test(String(url || ""));

function showStatus(message) {
  statusEl.textContent = message || "";
  statusEl.hidden = !message;
}

// ---------- tabs ----------

function renderTab(tab) {
  tab.labelEl.textContent = tab.loading && !tab.title ? "Loading…" : tab.title || "New Tab";
  tab.tabEl.title = tab.title || "New Tab";
  tab.tabEl.classList.toggle("active", tab === activeTab);
  tab.tabEl.classList.toggle("loading", Boolean(tab.loading));
}

function updateAddress() {
  if (activeTab && document.activeElement !== addressEl) addressEl.value = displayUrl(activeTab.url);
  updateStar();
}

function focusAddress() {
  if (platform.focusUi) platform.focusUi(); // in the app, a page may have the keyboard
  addressEl.focus();
  addressEl.select();
}

// What the tab area shows: one of Kite's pages, or the tab's real page.
let shownPage = null; // { tabId, name, view }
function showContent(tab) {
  if (tab.page) {
    platform.showView(null); // hide every real page
    internalEl.hidden = false;
    if (!shownPage || shownPage.tabId !== tab.id || shownPage.name !== tab.page) {
      shownPage = { tabId: tab.id, name: tab.page, view: renderPage(tab.page, internalEl, pageContext) };
    }
  } else {
    internalEl.hidden = true;
    platform.showView(tab.id);
  }
}

function selectTab(tab) {
  activeTab = tab;
  showContent(tab);
  tabs.forEach(renderTab);
  updateAddress();
  features.tabSelected(tab);
  if (!tab.url || tab.page === "newtab") focusAddress();
}

function createTab(input, { select = true } = {}) {
  const tab = { id: nextId++, url: null, title: "New Tab", loading: false, security: "kite", page: null, viewUrl: null };
  tab.tabEl = document.createElement("div");
  tab.tabEl.className = "tab";
  tab.labelEl = document.createElement("span");
  tab.labelEl.className = "title";
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.title = "Close tab";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  tab.tabEl.append(tab.labelEl, close);
  tab.tabEl.addEventListener("click", () => selectTab(tab));
  tab.tabEl.addEventListener("auxclick", (e) => e.button === 1 && closeTab(tab)); // middle click
  tab.tabEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    features.tabMenu(tab);
  });
  tabsEl.appendChild(tab.tabEl);

  tabs.push(tab);
  platform.createView(tab.id);
  if (input) navigate(input, tab);
  else openPage(tab, "newtab");
  if (select || !activeTab) selectTab(tab);
  else renderTab(tab);
  saveSession();
  return tab;
}

const closed = []; // recently closed pages, for Ctrl+Shift+T

function closeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  if (tab.url && (isWeb(tab.url) || tab.page)) closed.push(tab.url);
  if (closed.length > 25) closed.shift();
  tabs.splice(index, 1);
  features.tabClosed(tab);
  platform.closeView(tab.id);
  tab.tabEl.remove();
  if (shownPage && shownPage.tabId === tab.id) shownPage = null;
  if (!tabs.length) createTab();
  else if (tab === activeTab) selectTab(tabs[Math.min(index, tabs.length - 1)]);
  saveSession();
}

const tabById = (id) => tabs.find((t) => t.id === id);

// ---------- navigation ----------

// Show one of Kite's own pages in a tab.
function openPage(tab, name) {
  tab.page = name;
  tab.url = name === "newtab" ? null : "kite://" + name;
  tab.title = PAGES[name];
  tab.loading = false;
  tab.security = "kite";
  renderTab(tab);
  if (tab === activeTab) {
    showContent(tab);
    addressEl.blur();
    updateAddress();
    features.tabSelected(tab);
    if (shownPage && shownPage.view.focus) shownPage.view.focus();
  }
}

async function navigate(input, tab = activeTab) {
  if (!tab) return;
  const page = pageOf(input);
  if (page) return openPage(tab, page);
  const url = toUrl(input, settings().searchEngine);
  if (!url) return;
  const leaving = Boolean(tab.page);
  tab.page = null;
  tab.url = url;
  tab.title = "";
  tab.loading = true;
  renderTab(tab);
  if (tab === activeTab) {
    addressEl.blur();
    if (leaving) showContent(tab);
    updateAddress();
  }
  await platform.navigate(tab.id, url);
}

function reloadAll() {
  for (const tab of tabs) if (tab.url && !tab.page) navigate(tab.url, tab);
}

// Back from one of Kite's pages returns to the website the tab was on.
function goBack(tab) {
  if (tab.page && tab.viewUrl) {
    tab.page = null;
    tab.url = tab.viewUrl;
    tab.title = tab.viewTitle || "";
    tab.security = /^https:/i.test(tab.viewUrl) ? "secure" : "insecure";
    renderTab(tab);
    if (tab === activeTab) selectTab(tab);
    return;
  }
  if (!tab.page) platform.command(tab.id, "back");
}

function goHome(tab = activeTab) {
  navigate(settings().homePage || "kite://newtab", tab);
}

// ---------- history, bookmarks and the session ----------

// A page reported its address (a visit, unless it's the one already recorded
// for this tab) or its title (fills in the visit's title).
function recordVisit(tab, info) {
  if (!settings().recordHistory) return;
  if ("url" in info && isWeb(info.url) && info.url !== tab.visited) {
    tab.visited = info.url;
    store.update("history", (h) => D.addVisit(h, { url: info.url, title: tab.title }));
  } else if (info.title && isWeb(tab.url)) {
    store.update("history", (h) => D.setVisitTitle(h, tab.url, info.title));
  }
}

let sessionTimer = null;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const next = D.sessionFrom(tabs);
    if (JSON.stringify(next) !== JSON.stringify(store.get("session"))) store.set("session", next);
  }, 500);
}

function updateStar() {
  const tab = activeTab;
  const can = Boolean(tab && !tab.page && isWeb(tab.url));
  starEl.hidden = !can;
  const marked = can && D.findBookmark(store.get("bookmarks"), tab.url);
  starEl.textContent = marked ? "★" : "☆";
  starEl.classList.toggle("on", Boolean(marked));
  starEl.title = marked ? "Edit bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)";
}

// Ctrl+D or the star: bookmark the page (if it isn't) and show the bookmark panel.
function bookmarkPage() {
  const tab = activeTab;
  if (!tab || tab.page || !isWeb(tab.url)) return;
  if (!D.findBookmark(store.get("bookmarks"), tab.url)) {
    store.update("bookmarks", (b) => D.addBookmark(b, { url: tab.url, title: tab.title }));
  }
  const b = D.findBookmark(store.get("bookmarks"), tab.url);
  const panel = document.getElementById("bookmark-panel");
  const name = document.getElementById("bookmark-name");
  panel.dataset.id = b.id;
  name.value = b.title;
  features.openPanel(panel, true);
  if (platform.focusUi) platform.focusUi();
  name.focus();
  name.select();
}

function setUpBookmarkPanel() {
  const panel = document.getElementById("bookmark-panel");
  const name = document.getElementById("bookmark-name");
  document.getElementById("bookmark-form").addEventListener("submit", (e) => {
    e.preventDefault();
    store.update("bookmarks", (b) => D.updateBookmark(b, panel.dataset.id, { title: name.value.trim() }));
    panel.hidden = true;
  });
  document.getElementById("bookmark-remove").addEventListener("click", () => {
    store.update("bookmarks", (b) => D.removeBookmark(b, panel.dataset.id));
    panel.hidden = true;
  });
}

function renderBookmarksBar() {
  const list = store.get("bookmarks");
  barEl.hidden = !settings().showBookmarksBar || !list.length;
  barEl.textContent = "";
  for (const b of list) {
    const a = document.createElement("a");
    a.href = b.url;
    a.className = "bm";
    a.textContent = b.title || b.url;
    a.title = `${b.title}\n${b.url}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.shiftKey) createTab(b.url, { select: e.shiftKey });
      else navigate(b.url);
    });
    a.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      createTab(b.url, { select: false });
    });
    barEl.append(a);
  }
  const all = document.createElement("a");
  all.href = "kite://bookmarks";
  all.className = "bm all";
  all.textContent = "All bookmarks";
  all.addEventListener("click", (e) => (e.preventDefault(), navigate("kite://bookmarks")));
  barEl.append(all);
}

function applySettings() {
  document.getElementById("home").hidden = !settings().showHomeButton;
  renderBookmarksBar();
}

// ---------- features: padlock, permissions, find, zoom, downloads, profiles, menus ----------

const features = initFeatures({
  platform,
  activeTab: () => activeTab,
  tabs: () => tabs.slice(),
  createTab,
  closeTab,
  reopen: () => closed.length && createTab(closed.pop()),
  canReopen: () => closed.length > 0,
  focusUi: () => platform.focusUi && platform.focusUi(),
  run: (name) => runShortcut(name),
  searchEngine: () => settings().searchEngine,
});

// What Kite's own pages can do.
const pageContext = {
  store,
  open: (url, { newTab } = {}) => (newTab ? createTab(url, { select: false }) : navigate(url)),
  navigate: (input) => navigate(input),
  action: (name) => runShortcut(name),
  favicons: Boolean(platform.features.favicons),
  hasProfiles: Boolean(platform.features.profiles),
  sync: platform.sync || null, // the app: syncing with a Kite account
  platformName: platform.kind === "desktop" ? "app" : "web",
};

store.onChange((name) => {
  if (name === "bookmarks") {
    renderBookmarksBar();
    updateStar();
  }
  if (name === "settings") applySettings();
  if (shownPage && !internalEl.hidden) shownPage.view.refresh(name);
});

// ---------- the platform tells us what happens in tabs ----------

platform.start({
  // A tab's page changed: its address, title, loading state, security.
  pageChanged(id, info) {
    const tab = tabById(id);
    if (!tab) return;
    if ("url" in info && info.url) tab.viewUrl = info.url;
    if ("title" in info && tab.viewUrl) tab.viewTitle = info.title;
    if (tab.page) return; // a Kite page is showing; its real page waits underneath
    const changedUrl = "url" in info && (info.url || null) !== tab.url;
    if ("url" in info) tab.url = info.url || null;
    if ("title" in info) tab.title = info.title || "";
    if ("loading" in info) tab.loading = info.loading;
    if ("security" in info) tab.security = info.security;
    if (!tab.title && tab.url && !tab.loading) {
      try {
        tab.title = new URL(tab.url).hostname;
      } catch {}
    }
    if (!tab.url && !tab.loading) tab.title = "New Tab";
    renderTab(tab);
    if (tab === activeTab) updateAddress();
    features.pageChanged(tab);
    recordVisit(tab, info);
    if (changedUrl || "url" in info) saveSession();
  },
  // A page asked for a new tab (window.open, target=_blank, ctrl+click).
  openTab(url) {
    createTab(url);
  },
  status: showStatus,
  // A key pressed inside a page (the app forwards browser shortcuts).
  shortcut(name) {
    runShortcut(name);
  },
  // The new tab page's search box, in the app (the old one, loaded in a tab).
  navigateRequest(id, input) {
    const tab = tabById(id);
    if (tab) navigate(input, tab);
  },
  // Something (e.g. signing in or out) means every open page should be loaded again.
  reloadAll,
  find: (id, active, total) => features.find(id, active, total),
  zoom: (id, percent) => {
    const tab = tabById(id);
    if (tab) features.zoom(tab, percent);
  },
  permission: (request) => features.permission(request),
  permissionDone: (id) => features.permissionDone(id),
  downloads: (list) => features.downloads(list),
  search: (text) => features.search(text),
});

// ---------- toolbar ----------

document.getElementById("toolbar").addEventListener("submit", (e) => {
  e.preventDefault();
  navigate(addressEl.value);
});
addressEl.addEventListener("focus", () => addressEl.select());
addressEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    addressEl.value = displayUrl(activeTab && activeTab.url);
    addressEl.blur();
  }
});
document.getElementById("new-tab").addEventListener("click", () => createTab());
document.getElementById("back").addEventListener("click", () => activeTab && goBack(activeTab));
document.getElementById("forward").addEventListener("click", () => activeTab && !activeTab.page && platform.command(activeTab.id, "forward"));
document.getElementById("reload").addEventListener("click", () => SHORTCUTS.reload());
document.getElementById("home").addEventListener("click", () => goHome());
starEl.addEventListener("click", bookmarkPage);
const popout = document.getElementById("popout");
if (popout) popout.addEventListener("click", () => activeTab && isWeb(activeTab.url) && platform.popout(activeTab.id, activeTab.url));
setUpBookmarkPanel();

// Keyboard shortcuts, like other browsers. In the app they work wherever the
// keyboard is (main.js forwards them from pages); on Kite Web, while Kite's
// toolbar has the keyboard (the browser keeps Ctrl+T and Ctrl+W for itself).
const SHORTCUTS = {
  "new-tab": () => createTab(),
  "close-tab": () => activeTab && closeTab(activeTab),
  "reopen-tab": () => closed.length && createTab(closed.pop()),
  "focus-address": () => focusAddress(),
  "next-tab": () => tabs.length && selectTab(tabs[(tabs.indexOf(activeTab) + 1) % tabs.length]),
  "prev-tab": () => tabs.length && selectTab(tabs[(tabs.indexOf(activeTab) + tabs.length - 1) % tabs.length]),
  reload: () => {
    if (!activeTab) return;
    if (activeTab.page) openPage(activeTab, activeTab.page);
    else platform.command(activeTab.id, "reload");
  },
  back: () => activeTab && goBack(activeTab),
  forward: () => activeTab && !activeTab.page && platform.command(activeTab.id, "forward"),
  home: () => goHome(),
  history: () => createTab("kite://history"),
  bookmarks: () => createTab("kite://bookmarks"),
  settings: () => createTab("kite://settings"),
  bookmark: () => bookmarkPage(),
  "bookmarks-bar": () => store.set("settings", { ...settings(), showBookmarksBar: !settings().showBookmarksBar }),
};
function shortcutFor(e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && e.shiftKey && key === "tab") return "prev-tab";
  if (mod && key === "tab") return "next-tab";
  if (mod && e.shiftKey && key === "t") return "reopen-tab";
  if (mod && e.shiftKey && key === "b") return "bookmarks-bar";
  if (mod && e.shiftKey && key === "o") return "bookmarks";
  if (mod && key === "t") return "new-tab";
  if (mod && key === "w") return "close-tab";
  if (mod && key === "l") return "focus-address";
  if (mod && key === "h") return "history";
  if (mod && key === "d") return "bookmark";
  if ((mod && key === "r") || key === "f5") return "reload";
  if (mod && e.shiftKey && key === "n") return "guest-window";
  if (mod && key === "n") return "new-window";
  if (mod && key === "f") return "find";
  if (mod && key === "p") return "print";
  if (mod && key === "j") return "downloads";
  if (mod && (key === "=" || key === "+")) return "zoom-in";
  if (mod && key === "-") return "zoom-out";
  if (mod && key === "0") return "zoom-reset";
  if (e.altKey && key === "home") return "home";
  if (e.altKey && key === "arrowleft") return "back";
  if (e.altKey && key === "arrowright") return "forward";
  return null;
}
// Tabs, navigation and Kite's pages here; the rest (find, zoom, print,
// downloads, windows) where the platform has it, otherwise the key does what it
// normally does.
function canRun(name) {
  return Boolean(SHORTCUTS[name]) || features.available(name);
}
function runShortcut(name) {
  if (SHORTCUTS[name]) SHORTCUTS[name]();
  else if (features.available(name)) features.actions[name]();
}
document.addEventListener("keydown", (e) => {
  const name = shortcutFor(e);
  if (!name || !canRun(name)) return;
  e.preventDefault();
  runShortcut(name);
});

// The old new tab page's search box (Kite Web loads it in an iframe).
window.browserNavigate = (input) => navigate(input);

// For the platform's own extras (e.g. Kite Web's account panel).
window.kite = { navigate, createTab, reloadAll, tabs: () => tabs.slice(), store };

// ---------- start ----------

applySettings();
// The app can open a window with pages already (e.g. "Open link in new window");
// otherwise what Settings > On startup says.
const startUrls = platform.startUrls ? await platform.startUrls() : [];
const startSettings = settings();
const first = startUrls.length
  ? startUrls
  : startSettings.startup === "continue" && store.get("session").length
    ? store.get("session")
    : startSettings.startup === "home" && startSettings.homePage
      ? [startSettings.homePage]
      : [];
if (first.length) first.forEach((u, i) => createTab(u, { select: i === 0 }));
else createTab();
