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
// Open the current page outside Kite's frame, in a real browser window (still
// through Kite). Handy for testing: there, a crashed page shows the browser's
// own error page with an error code.
document.getElementById("popout").addEventListener("click", () => {
  if (!activeTab || !activeTab.url) return;
  const win = window.open("about:blank", "_blank");
  getTicket().then((ticket) => {
    if (win) win.location.href = proxied(activeTab.url, ticket);
  });
});

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
// ---------- Kite accounts ----------
// Signing in to Kite gives this browser your account's cookie jar (your site
// logins), the same on every device. Guests each get their own separate jar.

const accountPanel = document.getElementById("account-panel");
const accountBtn = document.getElementById("account");
const accountMsg = document.getElementById("account-message");
let currentUser = null;

async function accountApi(path, body) {
  const r = await fetch(backend() + "/__kite/account" + path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `backend answered ${r.status}`);
  return data;
}

function showAccount(user, signupOn = true, googleOn = undefined) {
  if (googleOn !== undefined) document.getElementById("account-google").hidden = !googleOn;
  currentUser = user;
  accountBtn.classList.toggle("signed-in", Boolean(user));
  accountBtn.title = user ? `Signed in as ${user}` : "Kite account (guest)";
  document.getElementById("account-guest").hidden = Boolean(user);
  document.getElementById("account-user-view").hidden = !user;
  document.getElementById("account-name").textContent = user || "";
  document.getElementById("account-signup").hidden = !signupOn;
}

// Pages in open tabs were loaded with the old account's cookies.
function reloadTabs() {
  for (const tab of tabs) if (tab.url) navigate(tab.url, tab);
  if (!cookiePanel.hidden) updateCookies();
}

async function accountAction(path, body) {
  accountMsg.textContent = "...";
  try {
    const data = await accountApi(path, body);
    accountMsg.textContent = "";
    document.getElementById("account-pass").value = "";
    showAccount(data.user);
    try { localStorage.setItem("kite-account-seen", "1"); } catch {}
    accountPanel.hidden = true;
    reloadTabs();
  } catch (err) {
    accountMsg.textContent = err.message;
  }
}

accountBtn.addEventListener("click", () => {
  accountPanel.hidden = !accountPanel.hidden;
  if (!accountPanel.hidden) document.getElementById(currentUser ? "account-signout" : "account-user").focus();
});
document.getElementById("account-form").addEventListener("submit", (e) => {
  e.preventDefault();
  accountAction("/signin", { username: document.getElementById("account-user").value, password: document.getElementById("account-pass").value });
});
document.getElementById("account-signup").addEventListener("click", () => {
  const username = document.getElementById("account-user").value;
  const password = document.getElementById("account-pass").value;
  if (!username || !password) return (accountMsg.textContent = "Pick a username and a password (8+ characters), then click Create account.");
  accountAction("/signup", { username, password });
});
// Sign in with Google: Google opens in a popup; this page then collects the
// result with a secret only it knows (so it lands in this page's Kite session).
document.getElementById("account-google").addEventListener("click", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const claim = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const start = `${backend()}/__kite/google/start?claim=${claim}&origin=${encodeURIComponent(location.origin)}`;
  const popup = window.open(start, "kite-google", "width=500,height=680");
  if (!popup) return (accountMsg.textContent = "Allow pop-ups for Kite, then try again.");
  accountMsg.textContent = "Finish signing in with Google in the pop-up window...";
  const began = Date.now();
  let closedAt = 0;
  const poll = async () => {
    try {
      const r = await fetch(backend() + "/__kite/account/google", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 200) {
        accountMsg.textContent = "";
        showAccount(data.user);
        try { localStorage.setItem("kite-account-seen", "1"); } catch {}
        accountPanel.hidden = true;
        reloadTabs();
        return;
      }
      if (r.status !== 202) return (accountMsg.textContent = data.error || `backend answered ${r.status}`);
    } catch {}
    // A window Google showed can look "closed" to this page, so keep trying a
    // little after that, and give up after 10 minutes.
    let closed = false;
    try { closed = popup.closed; } catch {}
    if (closed && !closedAt) closedAt = Date.now();
    if ((closedAt && Date.now() - closedAt > 8000) || Date.now() - began > 10 * 60 * 1000) {
      accountMsg.textContent = "Google sign-in didn't finish.";
      return;
    }
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 1000);
});
document.getElementById("account-guest-go").addEventListener("click", () => {
  try { localStorage.setItem("kite-account-seen", "1"); } catch {}
  accountPanel.hidden = true;
});
document.getElementById("account-signout").addEventListener("click", () => accountAction("/signout", {}));
document.getElementById("account-signout-all").addEventListener("click", () => {
  if (confirm("Sign out of your Kite account on every device?")) accountAction("/signout-everywhere", {});
});

async function loadAccount() {
  try {
    const data = await accountApi("");
    showAccount(data.user, data.signup, data.google);
    let seen = false;
    try { seen = localStorage.getItem("kite-account-seen") === "1"; } catch {}
    if (!data.user && !seen) accountPanel.hidden = false; // first visit: sign in or continue as guest
  } catch {}
}
loadAccount();

// Import cookies exported from your normal browser (to be signed in inside Kite).
const importBox = document.getElementById("cookie-import");
const importText = document.getElementById("cookie-import-text");
const importResult = document.getElementById("cookie-import-result");
document.getElementById("cookies-import-open").addEventListener("click", () => {
  importBox.hidden = !importBox.hidden;
});
document.getElementById("cookie-import-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importText.value = await file.text();
});
document.getElementById("cookie-import-go").addEventListener("click", async () => {
  const text = importText.value.trim();
  if (!text) return (importResult.textContent = "Paste cookies or choose a file first.");
  importResult.textContent = "Importing...";
  try {
    const r = await fetch(backend() + "/__kite/cookies/import", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "text/plain" },
      body: text,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `backend answered ${r.status}`);
    importText.value = ""; // don't leave sign-in cookies lying around on screen
    importResult.textContent = `Imported ${data.imported} of ${data.found} cookies. Reload the site's tab to use them.`;
    renderCookies(data.sites);
  } catch (err) {
    importResult.textContent = `Couldn't import: ${err.message}`;
  }
});
document.getElementById("cookies-clear-all").addEventListener("click", () => {
  if (confirm("Clear all cookies? You'll be signed out of every site.")) updateCookies("cookies/clear", { site: "" });
});

// ---------- start ----------

checkBackend();
createTab();
