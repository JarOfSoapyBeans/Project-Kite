// Kite backend. No dependencies.
//   /proxy/<url>  pages, images, scripts... (Stages 1-2)
//   /ws/<url>     WebSocket relay (Stage 3)

import http from "node:http";
import { handleProxy, PREFIX, decodeUrl, resolveViaReferer, toProxyUrl } from "./proxy.js";
import { handleWebSocket, WS_PREFIX } from "./websocket.js";

const PORT = Number(process.env.PORT || 8080);

// Comma-separated origins of your Kite frontend, e.g.
// ALLOWED_ORIGINS=https://kite.vercel.app,http://localhost:3000
// Without it, anyone who finds this server can use it as a proxy.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_ACTIVE_PER_IP = Number(process.env.MAX_ACTIVE_PER_IP || 100);
const MAX_WEBSOCKETS_PER_IP = Number(process.env.MAX_WEBSOCKETS_PER_IP || 30);
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
    return ownHosts(req).includes(ref.host) || ALLOWED_ORIGINS.includes(ref.origin);
  } catch {
    return false;
  }
}

// The names this server is reached by (directly, or through a forwarding proxy).
function ownHosts(req) {
  return [req.headers.host, String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()];
}

// WebSockets are opened by pages Kite is showing, which live on this server's origin.
function webSocketAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  if (req.headers["sec-fetch-site"] === "same-origin") return true; // set by the browser itself
  try {
    const origin = new URL(req.headers.origin);
    return ownHosts(req).includes(origin.host) || ALLOWED_ORIGINS.includes(origin.origin);
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

// ---------- WebSockets (Stage 3) ----------

const activeSockets = new Map();

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const reject = (status, text, why) => {
    console.log(`[kite ws ${status}] ${why}`);
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  if (!pathname.startsWith(WS_PREFIX)) return reject(404, "Not Found", req.url.slice(0, 80));
  if (!webSocketAllowed(req)) return reject(403, "Forbidden", `not from Kite (origin=${req.headers.origin || "(none)"})`);

  const ip = clientIp(req);
  const count = activeSockets.get(ip) || 0;
  if (count >= MAX_WEBSOCKETS_PER_IP) return reject(429, "Too Many Requests", `too many WebSockets from ${ip}`);
  activeSockets.set(ip, count + 1);
  socket.on("close", () => {
    const left = (activeSockets.get(ip) || 1) - 1;
    if (left <= 0) activeSockets.delete(ip);
    else activeSockets.set(ip, left);
  });

  handleWebSocket(req, socket, head, {
    ...proxyOptions,
    log: (status, url, detail, source = "kite") =>
      console.log(`[${source} ws ${status}] ${String(url).slice(0, 120)}${detail ? `  (${detail})` : ""}`),
  });
});

server.listen(PORT, () => {
  console.log(`Kite backend on :${PORT}  (pages: ${PREFIX}, websockets: ${WS_PREFIX}, health: /health)`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "ANY"}`);
});
