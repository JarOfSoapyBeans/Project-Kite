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

function selectTab(tab) {
  activeTab = tab;
  platform.showView(tab.id);
  tabs.forEach(renderTab);
  updateAddress();
  if (!tab.url) addressEl.focus();
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

function closeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
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

// Keyboard shortcuts, like other browsers.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "t") {
    e.preventDefault();
    createTab();
  } else if (mod && e.key.toLowerCase() === "w") {
    e.preventDefault();
    if (activeTab) closeTab(activeTab);
  } else if (mod && e.key.toLowerCase() === "l") {
    e.preventDefault();
    addressEl.focus();
  } else if (mod && e.key === "Tab") {
    e.preventDefault();
    const i = tabs.indexOf(activeTab);
    selectTab(tabs[(i + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]);
  } else if ((mod && e.key.toLowerCase() === "r") || e.key === "F5") {
    e.preventDefault();
    if (activeTab) platform.command(activeTab.id, "reload");
  } else if (e.altKey && e.key === "ArrowLeft") {
    if (activeTab) platform.command(activeTab.id, "back");
  } else if (e.altKey && e.key === "ArrowRight") {
    if (activeTab) platform.command(activeTab.id, "forward");
  }
});

// The new tab page's search box.
window.browserNavigate = (input) => navigate(input);

// For the platform's own extras (e.g. Kite Web's account panel).
window.kite = { navigate, createTab, reloadAll, tabs: () => tabs.slice() };

createTab();
