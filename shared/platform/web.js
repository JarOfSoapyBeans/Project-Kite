// Kite Web's platform layer: each tab is an iframe showing the page through the
// Kite backend (/proxy/<encoded url>). Proxied pages report their real address
// and title back with postMessage (see backend/proxy.js).

import { initWebPanels } from "./web-panels.js";

const NEW_TAB = "newtab.html";
const viewsEl = document.getElementById("views");
const frames = new Map(); // tab id -> iframe
let events = null;
let backendOk = false;

export function backend() {
  let url = window.APP_CONFIG.backendUrl;
  try {
    url = localStorage.getItem("backendUrl") || url;
  } catch {}
  return url.replace(/\/+$/, "");
}
const backendOrigin = () => new URL(backend()).origin;

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
  events.status(backendOk ? "" : `Can't reach the Kite backend at ${backend()}. Is it running, and is its port public?`);
  return backendOk;
}

function idOfWindow(win) {
  for (const [id, f] of frames) if (f.contentWindow === win) return id;
  return null;
}

const platform = {
  kind: "web",
  features: { accounts: true, cookies: true, popout: true, backendSettings: true, menu: true },

  start(ev) {
    events = ev;
    // Messages from proxied pages: their real address and title, or a request
    // to open a link in a new tab (window.open, target="_blank", ctrl+click).
    window.addEventListener("message", (e) => {
      if (e.origin !== backendOrigin()) return;
      const d = e.data;
      if (!d || d.kite !== 1) return;
      if (d.type === "open") {
        try {
          const u = new URL(String(d.url));
          if (u.protocol === "http:" || u.protocol === "https:") events.openTab(u.href);
        } catch {}
        return;
      }
      if (d.type !== "page") return;
      const id = idOfWindow(e.source);
      if (id !== null) events.pageChanged(id, { url: String(d.url), title: String(d.title || ""), loading: false });
    });
    checkBackend();
    initWebPanels({
      backend,
      reloadAll: () => events.reloadAll(),
      resetBackend: () => {
        backendOk = false;
        ticket = null;
        checkBackend();
      },
    });
  },

  createView(id) {
    const f = document.createElement("iframe");
    f.setAttribute("allow", "fullscreen; autoplay; clipboard-write; picture-in-picture");
    // Some hosts send "Referrer-Policy: same-origin", which would hide where the
    // request came from. The backend needs our origin to allow the request.
    f.referrerPolicy = "origin";
    f.addEventListener("load", () => {
      // Only same-origin pages (our new tab page) are readable here.
      try {
        if (f.contentWindow.location.pathname.endsWith("/" + NEW_TAB)) events.pageChanged(id, { url: null, title: "New Tab", loading: false });
      } catch {}
    });
    viewsEl.appendChild(f);
    frames.set(id, f);
  },

  closeView(id) {
    const f = frames.get(id);
    if (f) f.remove();
    frames.delete(id);
  },

  showView(id) {
    for (const [fid, f] of frames) f.classList.toggle("active", fid === id);
  },

  showNewTab(id) {
    const f = frames.get(id);
    if (f) f.src = NEW_TAB;
  },

  async navigate(id, url) {
    const f = frames.get(id);
    if (!f) return;
    if (!backendOk && !(await checkBackend())) {
      events.pageChanged(id, { loading: false });
      return;
    }
    f.src = proxied(url, await getTicket());
  },

  // Same-origin frames (the new tab page) can be driven directly; proxied pages
  // live on the backend's address, so their injected script is asked instead.
  command(id, cmd) {
    const f = frames.get(id);
    const w = f && f.contentWindow;
    if (!w) return;
    try {
      if (cmd === "back") w.history.back();
      else if (cmd === "forward") w.history.forward();
      else w.location.reload();
    } catch {
      w.postMessage({ kite: 1, cmd }, backendOrigin());
    }
  },

  // History, bookmarks, settings...: kept in this browser for now.
  async loadData(name) {
    try {
      return JSON.parse(localStorage.getItem("kite:" + name) || "null");
    } catch {
      return null;
    }
  },
  async saveData(name, value) {
    try {
      localStorage.setItem("kite:" + name, JSON.stringify(value));
    } catch {} // full or blocked: keep going without saving
  },
  // Other Kite Web tabs in this browser changed something.
  onDataChanged(fn) {
    window.addEventListener("storage", (e) => {
      if (e.key && e.key.startsWith("kite:")) {
        try {
          fn(e.key.slice(5), JSON.parse(e.newValue || "null"));
        } catch {}
      }
    });
  },

  // Open the page outside Kite's frame, in a real browser window (still through
  // Kite). There, a crashed page shows the browser's own error page and code.
  popout(id, url) {
    const win = window.open("about:blank", "_blank");
    getTicket().then((t) => {
      if (win) win.location.href = proxied(url, t);
    });
  },
};

export default platform;
