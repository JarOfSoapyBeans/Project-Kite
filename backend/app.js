// Kite backend: everything except reading settings and listening (see server.js).
// No dependencies.
//   /proxy/<url>  pages, images, scripts... (Stages 1-2)
//   /ws/<url>     WebSocket relay (Stage 3)
//   /__kite/...   Kite's own endpoints: cookies (Stage 4)

import http from "node:http";
import { handleProxy, PREFIX, decodeUrl, resolveViaReferer, toProxyUrl } from "./proxy.js";
import { handleWebSocket, WS_PREFIX } from "./websocket.js";
import { Sessions } from "./sessions.js";
import { siteOf } from "./cookies.js";
import { handleKiteApi, KITE_PREFIX } from "./kite-api.js";

// config:
//   allowedOrigins      your Kite frontend(s); without them anyone can use the proxy
//   allowedPorts        ports sites may be on (default 80, 443, 8080, 8443)
//   maxActivePerIp      concurrent page requests per visitor (default 100)
//   maxWebSocketsPerIp  open WebSockets per visitor (default 30)
//   trustCloudflare     read the visitor IP from CF-Connecting-IP (behind a Cloudflare Tunnel)
//   cookieFile          keep cookie jars in this file across restarts
//   allowPrivate        tests only: allow private/local addresses
//   log                 where log lines go (default console.log)
export function createKiteServer(config = {}) {
  const {
    allowedOrigins = [],
    allowedPorts,
    maxActivePerIp = 100,
    maxWebSocketsPerIp = 30,
    trustCloudflare = false,
    cookieFile = null,
    allowPrivate = false,
    log = console.log,
  } = config;

  const proxyOptions = { allowedOrigins, allowPrivate };
  if (allowedPorts !== undefined) proxyOptions.allowedPorts = allowedPorts;

  // One cookie jar per person using Kite (Stage 4).
  const sessions = new Sessions({ file: cookieFile });

  const clientIp = (req) => (trustCloudflare && req.headers["cf-connecting-ip"]) || req.socket.remoteAddress || "unknown";

  // The names this server is reached by (directly, or through a forwarding proxy).
  const ownHosts = (req) => [req.headers.host, String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()];

  // Proxy requests must come from the Kite frontend (the first page load in a
  // tab) or from a page already being proxied by this server.
  function originAllowed(req) {
    if (!allowedOrigins.length) return true;
    // You already have a Kite session (see sessions.js). Browsers sometimes drop
    // the Referer (some reloads, back/forward), so this is checked first.
    if (sessions.has(req)) return true;
    // The browser sets Sec-Fetch-Site itself (pages can't fake it). "same-origin"
    // means a page Kite is already showing made this request, even if that page
    // asked the browser to send no Referer.
    if (req.headers["sec-fetch-site"] === "same-origin") return true;
    try {
      const ref = new URL(req.headers.referer);
      return ownHosts(req).includes(ref.host) || allowedOrigins.includes(ref.origin);
    } catch {
      return false;
    }
  }

  // WebSockets are opened by pages Kite is showing, which live on this server's origin.
  function webSocketAllowed(req) {
    if (!allowedOrigins.length) return true;
    if (sessions.has(req)) return true; // you already have a Kite session
    if (req.headers["sec-fetch-site"] === "same-origin") return true; // set by the browser itself
    try {
      const origin = new URL(req.headers.origin);
      return ownHosts(req).includes(origin.host) || allowedOrigins.includes(origin.origin);
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

  // Concurrent-request counter per visitor IP.
  function limiter(max) {
    const counts = new Map();
    return (ip, onDone) => {
      const n = counts.get(ip) || 0;
      if (n >= max) return false;
      counts.set(ip, n + 1);
      onDone(() => {
        const left = (counts.get(ip) || 1) - 1;
        if (left <= 0) counts.delete(ip);
        else counts.set(ip, left);
      });
      return true;
    };
  }
  const requestSlot = limiter(maxActivePerIp);
  const socketSlot = limiter(maxWebSocketsPerIp);

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end("ok");
    }

    // Kite's own endpoints check their callers themselves.
    if (pathname.startsWith(KITE_PREFIX)) return handleKiteApi(req, res, { sessions, allowedOrigins });

    if (!originAllowed(req)) {
      log(
        `[kite 403: not from Kite] ${describe(req.url)}  referer=${req.headers.referer || "(none)"}` +
          ` sec-fetch-site=${req.headers["sec-fetch-site"] || "(none)"}` +
          ` kite-session=${/(?:^|;\s*)kite_sid=/.test(req.headers.cookie || "") ? "unknown" : "none"}`
      );
      res.writeHead(403, { "content-type": "text/plain", "x-kite-source": "kite" });
      return res.end("Forbidden: open this through the Kite frontend (see ALLOWED_ORIGINS).");
    }

    if (!requestSlot(clientIp(req), (done) => res.on("close", done))) {
      res.writeHead(429, { "content-type": "text/plain" });
      return res.end("Too many requests");
    }

    // Log every error, and whether Kite or the website produced it.
    // (Source maps are only fetched by browser DevTools; failures there don't matter.)
    res.on("finish", () => {
      if (res.statusCode < 400 || /\.(map|sourcemap)$/.test(pathname)) return;
      log(`[${res.getHeader("x-kite-source") || "kite"} ${res.statusCode}] ${describe(req.url)}`);
    });

    if (pathname.startsWith(PREFIX)) {
      const jar = sessions.jarFor(req, res);
      return handleProxy(req, res, { ...proxyOptions, jar, onCookies: () => sessions.changed() });
    }

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

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const reject = (status, text, why) => {
      log(`[kite ws ${status}] ${why}`);
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!pathname.startsWith(WS_PREFIX)) return reject(404, "Not Found", req.url.slice(0, 80));
    if (!webSocketAllowed(req)) return reject(403, "Forbidden", `not from Kite (origin=${req.headers.origin || "(none)"})`);
    const ip = clientIp(req);
    if (!socketSlot(ip, (done) => socket.on("close", done))) return reject(429, "Too Many Requests", `too many WebSockets from ${ip}`);

    // Cookies for the site, but only when the page opening the WebSocket is on the
    // same site (third-party cookies are blocked, see cookies.js).
    const jar = sessions.jarFor(req);
    handleWebSocket(req, socket, head, {
      ...proxyOptions,
      extraHeaders: (target, pageOrigin) => {
        if (!jar || !pageOrigin || siteOf(new URL(pageOrigin).hostname) !== siteOf(target.hostname)) return {};
        const cookie = jar.header(target);
        return cookie ? { cookie } : {};
      },
      onResponseHeaders: (target, headers) => {
        if (!jar) return;
        const set = headers.filter(([name]) => name === "set-cookie").map(([, value]) => value);
        if (set.length && jar.setAll(set, target)) sessions.changed();
      },
      log: (status, url, detail, source = "kite") =>
        log(`[${source} ws ${status}] ${String(url).slice(0, 120)}${detail ? `  (${detail})` : ""}`),
    });
  });

  return { server, sessions };
}
