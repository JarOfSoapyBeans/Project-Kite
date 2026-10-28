// Kite's own endpoints under /__kite/ (Stage 4). No dependencies.
//
//   POST /__kite/cookie            document.cookie writes from a proxied page
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
