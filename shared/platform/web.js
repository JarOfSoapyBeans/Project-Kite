// Kite Web's platform layer: each tab is an iframe showing the page through the
// Kite backend (/proxy/<encoded url>). Proxied pages report their real address
// and title back with postMessage (see backend/proxy.js).

import { initWebPanels } from "./web-panels.js";
import { createWebData } from "./web-data.js";

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

const data = createWebData(backend);

async function devtoolsApi(path, body) {
  const r = await fetch(backend() + "/__kite/devtools" + path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const answer = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(answer.error || `the backend answered ${r.status}`);
  return answer;
}
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const zooms = new Map(); // tab id -> zoom factor

// Ask a tab's page (its injected Kite client) to do something.
function tell(id, message) {
  const f = frames.get(id);
  if (f && f.contentWindow) f.contentWindow.postMessage({ kite: 1, ...message }, backendOrigin());
}

function idOfWindow(win) {
  for (const [id, f] of frames) if (f.contentWindow === win) return id;
  return null;
}

const platform = {
  kind: "web",
  features: {
    accounts: true, cookies: true, popout: true, backendSettings: true, menu: true,
    // done by the Kite client inside each page
    find: true, zoom: true, print: true, siteInfo: true,
  },

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
      const id = idOfWindow(e.source);
      if (id === null) return;
      // A tab's page asks to be opened on its own (Kite's YouTube video page:
      // the full YouTube page crashes Edge inside a frame).
      if (d.type === "popout") {
        try {
          const u = new URL(String(d.url));
          if (u.protocol === "http:" || u.protocol === "https:") platform.popout(id, u.href);
        } catch {}
        return;
      }
      if (d.type === "find") return events.find(id, Number(d.active) || 0, Number(d.total) || 0);
      if (d.type === "zoom") return events.zoom(id, Math.round(Number(d.percent) || 100));
      if (d.type !== "page") return;
      const url = String(d.url);
      frames.get(id).dataset.url = url;
      events.pageChanged(id, { url, title: String(d.title || ""), loading: false, security: /^https:/i.test(url) ? "secure" : "insecure" });
      // A new page keeps the tab's zoom.
      if ((zooms.get(id) || 1) !== 1) tell(id, { cmd: "zoom", factor: zooms.get(id) });
    });
    checkBackend();
    initWebPanels({
      backend,
      reloadAll: () => events.reloadAll(),
      accountChanged: (user) => data.accountChanged(user),
      resetBackend: () => {
        backendOk = false;
        ticket = null;
        checkBackend();
      },
    });
  },

  createView(id) {
    const f = document.createElement("iframe");
    // What a page in a tab may use. A frame only gets what's listed here (a page
    // shown on its own gets all of it): YouTube's player checks for protected
    // video ("encrypted-media"), and 360-degree videos use the motion sensors.
    // Same list as YouTube's own embed code, plus storage access.
    f.setAttribute("allow", "fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write; accelerometer; gyroscope; web-share; storage-access");
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
    zooms.delete(id);
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
    f.dataset.url = url;
    f.src = proxied(url, await getTicket());
  },

  // Same-origin frames (the new tab page) can be driven directly; proxied pages
  // live on the backend's address, so their injected script is asked instead.
  command(id, cmd) {
    const f = frames.get(id);
    const w = f && f.contentWindow;
    if (!w) return;
    if (cmd === "print") return tell(id, { cmd: "print" });
    try {
      if (cmd === "back") w.history.back();
      else if (cmd === "forward") w.history.forward();
      else w.location.reload();
    } catch {
      w.postMessage({ kite: 1, cmd }, backendOrigin());
    }
  },

  // History, bookmarks, settings...: in your Kite account when signed in,
  // otherwise in this browser (see web-data.js).
  loadData: (name) => data.load(name),
  saveData: (name, value) => data.save(name, value),
  onDataChanged: (fn) => data.onChange(fn),

  // Find, zoom, print: the Kite client inside the page does them.
  find: (id, text, opts = {}) => tell(id, { cmd: "find", text: String(text || ""), forward: opts.forward !== false, findNext: Boolean(opts.findNext) }),
  stopFind: (id) => tell(id, { cmd: "stop-find" }),
  zoom(id, dir) {
    const now = zooms.get(id) || 1;
    let next = 1;
    if (dir === "in") next = ZOOMS.find((z) => z > now + 0.001) || ZOOMS[ZOOMS.length - 1];
    else if (dir === "out") next = [...ZOOMS].reverse().find((z) => z < now - 0.001) || ZOOMS[0];
    zooms.set(id, next);
    tell(id, { cmd: "zoom", factor: next });
  },

  // The padlock: Kite Web shows the site's address and connection; site
  // permissions (camera...) are your browser's own, for Kite's address.
  // Kite Search (kite://search): the backend's own index.
  async search(q, page = 1) {
    const r = await fetch(backend() + "/__kite/search?q=" + encodeURIComponent(q) + "&page=" + page, { signal: AbortSignal.timeout(15000) });
    const answer = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(answer.error || `the backend answered ${r.status}`);
    return answer;
  },

  // Kite DevTools: what the Kite backend is doing (only for Kite accounts named
  // in its KITE_DEVTOOLS_USERS: it shows everyone's browsing through it).
  devtools: {
    check: () => devtoolsApi("/check"),
    events: (since) => devtoolsApi("/events?since=" + (Number(since) || 0)),
    status: () => devtoolsApi("/status"),
    clear: () => devtoolsApi("/clear", {}),
    settings: (changes) => devtoolsApi("/settings", changes || {}),
    // Kite Search's crawler: status, or { action: pause|resume|add, url }.
    search: (body) => devtoolsApi("/search", body || undefined),
  },

  async siteInfo(id) {
    const f = frames.get(id);
    const tabUrl = f && f.dataset.url;
    let origin = null;
    try {
      origin = new URL(tabUrl).origin;
    } catch {}
    return { origin, security: /^https:/i.test(tabUrl || "") ? "secure" : "insecure", permissions: {} };
  },
  async clearSite(id) {
    const f = frames.get(id);
    try {
      const host = new URL(f.dataset.url).hostname;
      await fetch(backend() + "/__kite/cookies/clear", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ site: host }).toString(),
      });
    } catch {}
  },
  resetPermissions: (id) => platform.siteInfo(id),

  // Open the page outside Kite's frame, in a real browser window (still through
  // Kite). There, a crashed page shows the browser's own error page and code.
  popout(id, url) {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      // Pop-ups blocked: show it in the tab after all.
      events.status("Your browser blocked the new tab. Allow pop-ups for Kite to open pages on their own.");
      if (id !== null && id !== undefined) platform.navigate(id, url);
      return;
    }
    getTicket().then((t) => {
      win.location.href = proxied(url, t);
    });
  },
};

export default platform;
