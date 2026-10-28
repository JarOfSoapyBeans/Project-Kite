// Kite UI: tabs, address bar, navigation. Each tab is an iframe pointed at the
// backend's /proxy/<encoded-url>. Proxied pages report their real URL and title
// back with postMessage.

const SEARCH_URL = "https://www.bing.com/search?q=";
const NEW_TAB = "/newtab.html";

const tabsEl = document.getElementById("tabs");
const viewsEl = document.getElementById("views");
const addressEl = document.getElementById("address");
const statusEl = document.getElementById("status");

const tabs = [];
let activeTab = null;
let backendOk = false;

// ---------- helpers ----------

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

function backend() {
  let url = window.APP_CONFIG.backendUrl;
  try {
    url = localStorage.getItem("backendUrl") || url;
  } catch {}
  return url.replace(/\/+$/, "");
}

function backendOrigin() {
  return new URL(backend()).origin;
}

function toUrl(input) {
  const value = input.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (!/\s/.test(value) && /^[^\s/]+\.[^\s/.]{2,}(\/.*)?$/.test(value)) return "https://" + value;
  return SEARCH_URL + encodeURIComponent(value);
}

function base64url(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function proxied(url, ticket) {
  const u = new URL(url);
  const hash = u.hash;
  u.hash = "";
  return backend() + "/proxy/" + base64url(u.href) + (ticket ? "?__kite_t=" + encodeURIComponent(ticket) : "") + hash;
}

// A pass from the backend proving tab loads come from this Kite UI. Needed when
// the browser sends no Referer and no cookies (privacy settings, some browsers).
let ticket = null;
let ticketTime = 0;
async function getTicket() {
  if (ticket && Date.now() - ticketTime < 60 * 60 * 1000) return ticket;
  try {
    const r = await fetch(backend() + "/__kite/ticket", { credentials: "include", signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      ticket = (await r.json()).ticket;
      ticketTime = Date.now();
    }
  } catch {}
  return ticket;
}

async function checkBackend() {
  try {
    const r = await fetch(backend() + "/health", { signal: AbortSignal.timeout(6000) });
    backendOk = r.ok;
  } catch {
    backendOk = false;
  }
  showStatus(backendOk ? "" : `Can't reach the Kite backend at ${backend()}. Is it running, and is its port public?`);
  return backendOk;
}

// ---------- tabs ----------

function renderTab(tab) {
  tab.labelEl.textContent = tab.title || "New Tab";
  tab.tabEl.classList.toggle("active", tab === activeTab);
  tab.iframe.classList.toggle("active", tab === activeTab);
}

function updateAddress() {
  if (activeTab) addressEl.value = activeTab.url || "";
}

function selectTab(tab) {
  activeTab = tab;
  tabs.forEach(renderTab);
  updateAddress();
}

function createTab(input) {
  const tab = { url: null, title: "New Tab" };

  tab.iframe = document.createElement("iframe");
  tab.iframe.setAttribute("allow", "fullscreen");
  // Codespaces (and some hosts) send "Referrer-Policy: same-origin", which would hide
  // where the request came from. The backend needs our origin to allow the request.
  tab.iframe.referrerPolicy = "origin";
  tab.iframe.addEventListener("load", () => {
    // Only same-origin pages (our new-tab page) are readable here.
    try {
      if (tab.iframe.contentWindow.location.pathname === NEW_TAB) {
        tab.url = null;
        tab.title = "New Tab";
        renderTab(tab);
        if (tab === activeTab) updateAddress();
      }
    } catch {}
  });
  viewsEl.appendChild(tab.iframe);

  tab.tabEl = document.createElement("div");
  tab.tabEl.className = "tab";
  tab.labelEl = document.createElement("span");
  tab.labelEl.className = "title";
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "\u00d7";
  close.title = "Close tab";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  tab.tabEl.append(tab.labelEl, close);
  tab.tabEl.addEventListener("click", () => selectTab(tab));
  tabsEl.appendChild(tab.tabEl);

  tabs.push(tab);
  selectTab(tab);
  if (input) navigate(input, tab);
  else tab.iframe.src = NEW_TAB;
  return tab;
}

function closeTab(tab) {
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  tab.iframe.remove();
  tab.tabEl.remove();
  if (!tabs.length) createTab();
  else if (tab === activeTab) selectTab(tabs[Math.min(index, tabs.length - 1)]);
}

// Messages from proxied pages: their real URL and title, or a request to open a
// link in a new tab (window.open, target="_blank", ctrl-click).
window.addEventListener("message", (e) => {
  if (e.origin !== backendOrigin()) return;
  const d = e.data;
  if (!d || d.kite !== 1) return;
  if (d.type === "open") {
    try {
      const u = new URL(String(d.url));
      if (u.protocol === "http:" || u.protocol === "https:") createTab(u.href);
    } catch {}
    return;
  }
  if (d.type !== "page") return;
  const tab = tabs.find((t) => t.iframe.contentWindow === e.source);
  if (!tab) return;
  tab.url = String(d.url);
  let host = tab.url;
  try {
    host = new URL(tab.url).hostname;
  } catch {}
  tab.title = String(d.title || "") || host;
  renderTab(tab);
  if (tab === activeTab) updateAddress();
});

// ---------- navigation ----------

async function navigate(input, tab = activeTab) {
  const url = toUrl(input);
  if (!url || !tab) return;
  if (!backendOk && !(await checkBackend())) return;
  tab.url = url;
  tab.title = "Loading\u2026";
  renderTab(tab);
  if (tab === activeTab) updateAddress();
  tab.iframe.src = proxied(url, await getTicket());
}

// Same-origin frames (new-tab page) can be driven directly; proxied pages
// live on the backend's origin, so ask their injected script instead.
function frameCommand(cmd) {
  const w = activeTab && activeTab.iframe.contentWindow;
  if (!w) return;
  try {
    if (cmd === "back") w.history.back();
    else if (cmd === "forward") w.history.forward();
    else w.location.reload();
  } catch {
    w.postMessage({ kite: 1, cmd }, backendOrigin());
  }
}

window.browserNavigate = (input) => navigate(input); // used by newtab.html

document.getElementById("toolbar").addEventListener("submit", (e) => {
  e.preventDefault();
  navigate(addressEl.value);
});
document.getElementById("new-tab").addEventListener("click", () => createTab());
document.getElementById("back").addEventListener("click", () => frameCommand("back"));
document.getElementById("forward").addEventListener("click", () => frameCommand("forward"));
document.getElementById("reload").addEventListener("click", () => frameCommand("reload"));

document.getElementById("settings").addEventListener("click", () => {
  const next = prompt("Kite backend URL (https://host):", backend());
  if (next === null) return;
  try {
    if (next.trim()) localStorage.setItem("backendUrl", next.trim());
    else localStorage.removeItem("backendUrl");
  } catch {}
  backendOk = false;
  ticket = null;
  checkBackend();
});

// ---------- cookies (Stage 4) ----------
// Sites' cookies live in a jar on the Kite backend. This panel lists them and
// lets you clear them; it talks to the backend directly (not through a tab).

const cookiePanel = document.getElementById("cookie-panel");
const cookieList = document.getElementById("cookie-list");

async function cookieApi(path, form) {
  const r = await fetch(backend() + "/__kite/" + path, {
    method: form ? "POST" : "GET",
    credentials: "include",
    headers: form ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  if (!r.ok) throw new Error(`backend answered ${r.status}`);
  return (await r.json()).sites;
}

function renderCookies(sites) {
  cookieList.textContent = "";
  const entries = Object.entries(sites).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    const li = document.createElement("li");
    li.textContent = "No cookies yet.";
    cookieList.append(li);
    return;
  }
  for (const [site, count] of entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "site";
    name.textContent = site;
    const n = document.createElement("span");
    n.className = "count";
    n.textContent = `${count} cookie${count === 1 ? "" : "s"}`;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => updateCookies("cookies/clear", { site }));
    li.append(name, n, clear);
    cookieList.append(li);
  }
}

async function updateCookies(path = "cookies", form) {
  try {
    renderCookies(await cookieApi(path, form));
  } catch (err) {
    cookieList.textContent = `Couldn't load cookies: ${err.message}`;
  }
}

document.getElementById("cookies").addEventListener("click", () => {
  cookiePanel.hidden = !cookiePanel.hidden;
  if (!cookiePanel.hidden) updateCookies();
});
document.getElementById("cookies-clear-all").addEventListener("click", () => {
  if (confirm("Clear all cookies? You'll be signed out of every site.")) updateCookies("cookies/clear", { site: "" });
});

// ---------- start ----------

checkBackend();
createTab();
