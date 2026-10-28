// Kite backend. Serves Kite's own proxy at /proxy/ (Stage 1). No dependencies.

import http from "node:http";
import { handleProxy, PREFIX, decodeUrl, resolveViaReferer, toProxyUrl } from "./proxy.js";

const PORT = Number(process.env.PORT || 8080);

// Comma-separated origins of your Kite frontend, e.g.
// ALLOWED_ORIGINS=https://kite.vercel.app,http://localhost:3000
// Without it, anyone who finds this server can use it as a proxy.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_ACTIVE_PER_IP = Number(process.env.MAX_ACTIVE_PER_IP || 100);
const TRUST_CF = process.env.TRUST_CF === "1"; // behind a Cloudflare Tunnel

const proxyOptions = { allowedOrigins: ALLOWED_ORIGINS };
if (process.env.ALLOWED_PORTS) {
  proxyOptions.allowedPorts = process.env.ALLOWED_PORTS.split(",").map(Number);
}

if (!ALLOWED_ORIGINS.length) console.warn("[warn] ALLOWED_ORIGINS is not set: anyone can use this proxy.");

const clientIp = (req) => (TRUST_CF && req.headers["cf-connecting-ip"]) || req.socket.remoteAddress || "unknown";

// Proxy requests must come from the Kite frontend (the first page load in a
// tab) or from a page already being proxied by this server.
function originAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  // The browser sets Sec-Fetch-Site itself (pages can't fake it). "same-origin"
  // means a page Kite is already showing made this request, even if that page
  // asked the browser to send no Referer.
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  try {
    const ref = new URL(req.headers.referer);
    const hosts = [req.headers.host, String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()];
    return hosts.includes(ref.host) || ALLOWED_ORIGINS.includes(ref.origin);
  } catch {
    return false;
  }
}

// Short, readable description of a request for the log.
function describe(url) {
  const { pathname } = new URL(url, "http://localhost");
  const real = pathname.startsWith(PREFIX) && decodeUrl(pathname.slice(PREFIX.length).split("/")[0]);
  return (real || url).slice(0, 120);
}

const active = new Map();

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    return res.end("ok");
  }

  if (!originAllowed(req)) {
    console.log(
      `[kite 403: not from Kite] ${describe(req.url)}  referer=${req.headers.referer || "(none)"}` +
        ` sec-fetch-site=${req.headers["sec-fetch-site"] || "(none)"}`
    );
    res.writeHead(403, { "content-type": "text/plain", "x-kite-source": "kite" });
    return res.end("Forbidden: open this through the Kite frontend (see ALLOWED_ORIGINS).");
  }

  const ip = clientIp(req);
  const count = active.get(ip) || 0;
  if (count >= MAX_ACTIVE_PER_IP) {
    res.writeHead(429, { "content-type": "text/plain" });
    return res.end("Too many requests");
  }
  active.set(ip, count + 1);
  res.on("close", () => {
    const left = (active.get(ip) || 1) - 1;
    if (left <= 0) active.delete(ip);
    else active.set(ip, left);
  });

  // Log every error, and whether Kite or the website produced it.
  // (Source maps are only fetched by browser DevTools; failures there don't matter.)
  res.on("finish", () => {
    if (res.statusCode < 400 || /\.(map|sourcemap)$/.test(pathname)) return;
    console.log(`[${res.getHeader("x-kite-source") || "kite"} ${res.statusCode}] ${describe(req.url)}`);
  });

  if (pathname.startsWith(PREFIX)) return handleProxy(req, res, proxyOptions);

  // A page asked for a root-relative URL we didn't rewrite (e.g. "/logo.png"
  // built by JavaScript). Send it to the matching proxied URL.
  const abs = resolveViaReferer(req, req.url);
  if (abs) {
    res.writeHead(307, { location: toProxyUrl(abs) });
    return res.end();
  }

  // No proxied page to resolve this against (e.g. DevTools fetching a source map).
  res.writeHead(pathname === "/" ? 200 : 404, { "content-type": "text/plain", "x-kite-source": "kite" });
  res.end(pathname === "/" ? "Kite backend is running." : "Not found");
});

server.listen(PORT, () => {
  console.log(`Kite backend on :${PORT}  (proxy: ${PREFIX}, health: /health)`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "ANY"}`);
});
