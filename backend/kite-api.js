// Kite's own endpoints under /__kite/ (Stage 4). No dependencies.
//
//   POST /__kite/cookie            document.cookie writes from a proxied page
//   POST /__kite/report            the browser's reports (e.g. a page crashed), printed
//   POST /__kite/log               errors and navigations on a proxied page, printed
//                                  in the backend's window (KITE_PAGE_LOG=0 turns off)
//   GET  /__kite/cookies           which sites you have cookies for   (Kite UI only)
//   POST /__kite/cookies/clear     forget cookies (all, or one site)  (Kite UI only)
//   GET  /__kite/ticket            a pass for loading pages in tabs   (Kite UI only)
//
// Proxied pages all live on the backend's address, so the cookie manager only
// answers cross-origin requests from your Kite frontend (ALLOWED_ORIGINS), never
// a page Kite is showing.

import { sourcePage } from "./proxy.js";

export const KITE_PREFIX = "/__kite/";

function readBody(req, limit) {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        resolve(null);
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(null));
  });
}

function send(res, status, body = "", headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}

// Page diagnostics: at most 60 lines a minute, control characters removed.
let logBudget = 60;
setInterval(() => (logBudget = 60), 60_000).unref();
const LOG_ON = process.env.KITE_PAGE_LOG !== "0";
function clean(text, max) {
  // Long URLs (video addresses are ~1500 characters) are cut down to stay readable.
  return String(text)
    .replace(/[\x00-\x09\x0b-\x1f\x7f\u2028\u2029]/g, " ")
    .replace(/https?:\/\/\S{120,}/g, (u) => u.slice(0, 110) + "...")
    .slice(0, max);
}
function printPageLog(body) {
  if (!LOG_ON || logBudget <= 0) return;
  let m;
  try {
    m = JSON.parse(body);
  } catch {
    return;
  }
  logBudget--;
  let page = "";
  try {
    const u = new URL(m.page);
    page = u.host + u.pathname + u.search;
  } catch {}
  const label = { navigate: "page navigate", crash: "PAGE CRASH", intervention: "page blocked" }[m.kind] || "page error";
  const lines = clean(m.text, 2000).split("\n").map((l) => l.trim()).filter(Boolean);
  console.log(`[${label}] ${clean(page, 120)}: ${lines[0] || ""}` + lines.slice(1, 8).map((l) => "\n      " + l).join(""));
}

// Reports the browser sends by itself (Reporting API). Only the ones that explain
// a broken page are printed: a crashed tab and features the browser blocked.
function printReports(body) {
  let list;
  try {
    list = JSON.parse(body);
  } catch {
    return;
  }
  for (const r of Array.isArray(list) ? list : [list]) {
    if (!r || (r.type !== "crash" && r.type !== "intervention")) continue;
    let page = "";
    try {
      const u = new URL(r.url);
      const m = /^\/proxy\/([A-Za-z0-9_-]+)/.exec(u.pathname);
      const real = m ? new URL(Buffer.from(m[1], "base64url").toString("utf8")) : u;
      page = real.host + real.pathname + (u.search || real.search);
    } catch {}
    const b = r.body || {};
    const text = r.type === "crash"
      ? `the page crashed (reason: ${b.reason || "unknown"}${b.is_top_level === false ? ", in a frame" : ""})` +
        (b.stack ? "\n" + b.stack : "")
      : `${b.message || b.id || "intervention"}${b.sourceFile ? ` (${b.sourceFile}:${b.lineNumber}:${b.columnNumber})` : ""}`;
    printPageLog(JSON.stringify({ kind: r.type, page: "https://" + page, text }));
  }
}

// Returns true if the request was a /__kite/ request (and has been answered).
export async function handleKiteApi(req, res, { sessions, allowedOrigins = [] }) {
  const { pathname } = new URL(req.url, "http://localhost");
  if (!pathname.startsWith(KITE_PREFIX)) return false;
  res.setHeader("x-kite-source", "kite");

  // document.cookie = "..." from a page: only for that page's own site.
  if (pathname === "/__kite/cookie") {
    if (req.method !== "POST" || req.headers["sec-fetch-site"] !== "same-origin") return send(res, 403), true;
    const page = sourcePage(req);
    const jar = sessions.jarFor(req);
    const body = await readBody(req, 8192);
    if (page && jar && body && jar.set(body.trim(), page, { fromScript: true })) sessions.changed();
    return send(res, 204), true;
  }

  if (pathname === "/__kite/report") {
    if (req.method === "OPTIONS") return send(res, 204), true;
    if (req.method !== "POST") return send(res, 405), true;
    const body = await readBody(req, 65536);
    if (body) printReports(body);
    return send(res, 204), true;
  }

  if (pathname === "/__kite/log") {
    if (req.method !== "POST" || req.headers["sec-fetch-site"] !== "same-origin") return send(res, 403), true;
    const body = await readBody(req, 8192);
    if (body) printPageLog(body);
    return send(res, 204), true;
  }

  // The cookie manager: only for the Kite UI.
  if (pathname === "/__kite/cookies" || pathname === "/__kite/cookies/clear" || pathname === "/__kite/ticket") {
    const origin = req.headers.origin;
    let fromUi = false;
    try {
      fromUi = allowedOrigins.length ? allowedOrigins.includes(origin) : new URL(origin).host !== req.headers.host;
    } catch {}
    const cors = fromUi ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {};
    if (req.method === "OPTIONS") return send(res, fromUi ? 204 : 403, "", { ...cors, "access-control-allow-methods": "GET, POST" }), true;
    if (!fromUi) return send(res, 403, "Only the Kite UI can manage cookies."), true;
    const jar = sessions.jarFor(req, res);
    if (pathname === "/__kite/ticket") {
      return send(res, 200, JSON.stringify({ ticket: sessions.issueTicket() }), { ...cors, "content-type": "application/json" }), true;
    }
    if (pathname === "/__kite/cookies/clear") {
      if (req.method !== "POST") return send(res, 405, "", cors), true;
      const site = new URLSearchParams((await readBody(req, 1024)) || "").get("site");
      jar.clear(site || undefined);
      sessions.changed();
    }
    return send(res, 200, JSON.stringify({ sites: jar.summary() }), { ...cors, "content-type": "application/json" }), true;
  }

  return send(res, 404), true;
}
