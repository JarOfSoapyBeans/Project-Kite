// Kite backend. Serves Kite's own proxy at /proxy/ (Stage 1). No dependencies.

import http from "node:http";
import { handleProxy, PREFIX, resolveViaReferer, toProxyUrl } from "./proxy.js";

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
  try {
    const ref = new URL(req.headers.referer);
    return ref.host === req.headers.host || ALLOWED_ORIGINS.includes(ref.origin);
  } catch {
    return false;
  }
}

const active = new Map();

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    return res.end("ok");
  }

  if (!originAllowed(req)) {
    console.log(`[reject] 403 referer=${req.headers.referer || "(none)"} path=${req.url.slice(0, 80)}`);
    res.writeHead(403, { "content-type": "text/plain" });
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

  if (pathname.startsWith(PREFIX)) return handleProxy(req, res, proxyOptions);

  // A page asked for a root-relative URL we didn't rewrite (e.g. "/logo.png"
  // built by JavaScript). Send it to the matching proxied URL.
  const abs = resolveViaReferer(req, req.url);
  if (abs) {
    res.writeHead(307, { location: toProxyUrl(abs) });
    return res.end();
  }

  res.writeHead(pathname === "/" ? 200 : 404, { "content-type": "text/plain" });
  res.end(pathname === "/" ? "Kite backend is running." : "Not found");
});

server.listen(PORT, () => {
  console.log(`Kite backend on :${PORT}  (proxy: ${PREFIX}, health: /health)`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "ANY"}`);
});
