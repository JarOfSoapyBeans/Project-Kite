// Kite's browser interface: tabs, toolbar, address bar. Shared by the Kite app
// (desktop) and Kite Web. Everything that depends on where Kite runs (how a tab
// shows a page, going back, reloading...) goes through the platform layer:
//   platform/web.js       Kite Web: each tab is an iframe through the Kite backend
//   platform/desktop.js   Kite app: each tab is a real browser view (Stage 7 part 2)
// The build copies the right one to platform/index.js.

import platform from "./platform/index.js";
import { toUrl, displayUrl } from "./lib/omnibox.js";

const tabsEl = document.getElementById("tabs");
const addressEl = document.getElementById("address");
const statusEl = document.getElementById("status");

const tabs = []; // { id, url, title, loading, tabEl, labelEl }
let activeTab = null;
let nextId = 1;

// Show only the buttons and panels this platform has (data-feature="...").
for (const el of document.querySelectorAll("[data-feature]")) {
  el.hidden = !platform.features[el.dataset.feature];
}

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
}

function focusAddress() {
  if (platform.focusUi) platform.focusUi(); // in the app, a page may have the keyboard
  addressEl.focus();
  addressEl.select();
}

function selectTab(tab) {
  activeTab = tab;
  platform.showView(tab.id);
  tabs.forEach(renderTab);
  updateAddress();
  if (!tab.url) focusAddress();
}

function createTab(input) {
  const tab = { id: nextId++, url: null, title: "New Tab", loading: false };
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
  tabsEl.appendChild(tab.tabEl);

  tabs.push(tab);
  platform.createView(tab.id);
  selectTab(tab);
  if (input) navigate(input, tab);
  else platform.showNewTab(tab.id);
  return tab;
}

const closed = []; // recently closed pages, for Ctrl+Shift+T

function closeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  if (tab.url) closed.push(tab.url);
  if (closed.length > 25) closed.shift();
  tabs.splice(index, 1);
  platform.closeView(tab.id);
  tab.tabEl.remove();
  if (!tabs.length) createTab();
  else if (tab === activeTab) selectTab(tabs[Math.min(index, tabs.length - 1)]);
}

const tabById = (id) => tabs.find((t) => t.id === id);

// ---------- navigation ----------

async function navigate(input, tab = activeTab) {
  const url = toUrl(input);
  if (!url || !tab) return;
  tab.url = url;
  tab.title = "";
  tab.loading = true;
  renderTab(tab);
  if (tab === activeTab) {
    addressEl.blur();
    updateAddress();
  }
  await platform.navigate(tab.id, url);
}

function reloadAll() {
  for (const tab of tabs) if (tab.url) navigate(tab.url, tab);
}

// ---------- the platform tells us what happens in tabs ----------

platform.start({
  // A tab's page changed: its address, title, or whether it's loading.
  pageChanged(id, info) {
    const tab = tabById(id);
    if (!tab) return;
    if ("url" in info) tab.url = info.url || null;
    if ("title" in info) tab.title = info.title || "";
    if ("loading" in info) tab.loading = info.loading;
    if (!tab.title && tab.url && !tab.loading) {
      try {
        tab.title = new URL(tab.url).hostname;
      } catch {}
    }
    if (!tab.url && !tab.loading) tab.title = "New Tab";
    renderTab(tab);
    if (tab === activeTab) updateAddress();
  },
  // A page asked for a new tab (window.open, target=_blank, ctrl+click).
  openTab(url) {
    createTab(url);
  },
  status: showStatus,
  // A key pressed inside a page (the app forwards browser shortcuts).
  shortcut(name) {
    if (SHORTCUTS[name]) SHORTCUTS[name]();
  },
  // The new tab page's search box, in the app.
  navigateRequest(id, input) {
    const tab = tabById(id);
    if (tab) navigate(input, tab);
  },
  // Something (e.g. signing in or out) means every open page should be loaded again.
  reloadAll,
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
document.getElementById("back").addEventListener("click", () => activeTab && platform.command(activeTab.id, "back"));
document.getElementById("forward").addEventListener("click", () => activeTab && platform.command(activeTab.id, "forward"));
document.getElementById("reload").addEventListener("click", () => activeTab && platform.command(activeTab.id, "reload"));
const popout = document.getElementById("popout");
if (popout) popout.addEventListener("click", () => activeTab && activeTab.url && platform.popout(activeTab.id, activeTab.url));

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
  reload: () => activeTab && platform.command(activeTab.id, "reload"),
  back: () => activeTab && platform.command(activeTab.id, "back"),
  forward: () => activeTab && platform.command(activeTab.id, "forward"),
};
function shortcutFor(e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && e.shiftKey && key === "tab") return "prev-tab";
  if (mod && key === "tab") return "next-tab";
  if (mod && e.shiftKey && key === "t") return "reopen-tab";
  if (mod && key === "t") return "new-tab";
  if (mod && key === "w") return "close-tab";
  if (mod && key === "l") return "focus-address";
  if ((mod && key === "r") || key === "f5") return "reload";
  if (e.altKey && key === "arrowleft") return "back";
  if (e.altKey && key === "arrowright") return "forward";
  return null;
}
document.addEventListener("keydown", (e) => {
  const name = shortcutFor(e);
  if (!name) return;
  e.preventDefault();
  SHORTCUTS[name]();
});

// The new tab page's search box.
window.browserNavigate = (input) => navigate(input);

// For the platform's own extras (e.g. Kite Web's account panel).
window.kite = { navigate, createTab, reloadAll, tabs: () => tabs.slice() };

createTab();
