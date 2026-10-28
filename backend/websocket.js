// Kite's WebSocket relay (Stage 3). No dependencies.
//
// A page inside Kite opens   wss://<kite-backend>/ws/<real wss URL>/<page origin>
// (both parts base64url). The backend checks the target like any other request
// (SSRF guard, allowed ports), opens the real ws:// or wss:// connection, does the
// WebSocket handshake with the site on the page's behalf, then simply passes the
// frames back and forth unchanged. Compression and subprotocols are negotiated
// end to end between the page and the site.

import net from "node:net";
import tls from "node:tls";
import { checkTarget, guardedLookup } from "./proxy.js";

export const WS_PREFIX = "/ws/";
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_HANDSHAKE = 16 * 1024;

// Headers from the page's handshake that the site needs to see.
const PASS_TO_SITE = [
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions",
  "user-agent", "accept-language", "cache-control", "pragma",
];
// Headers from the site's reply that the page's browser needs to see.
const PASS_TO_PAGE = ["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"];

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s) => Buffer.from(s || "", "base64url").toString("utf8");

export function encodeWsPath(target, origin) {
  return WS_PREFIX + b64(target) + (origin ? "/" + b64(origin) : "");
}

// "/ws/<target>/<origin>" -> { target: URL, origin: string|null }, or null.
export function decodeWsPath(pathname) {
  const [t, o] = pathname.slice(WS_PREFIX.length).split("/");
  let target;
  try {
    target = new URL(unb64(t));
  } catch {
    return null;
  }
  if (target.protocol !== "ws:" && target.protocol !== "wss:") return null;
  let origin = null;
  try {
    const u = new URL(unb64(o));
    if (u.protocol === "http:" || u.protocol === "https:") origin = u.origin;
  } catch {}
  return { target, origin };
}

// options: allowPrivate (tests only), allowedPorts, log(status, url, detail, source)
export function handleWebSocket(req, socket, head, options = {}) {
  const o = { allowPrivate: false, allowedPorts: [80, 443, 8080, 8443], log: () => {}, ...options };
  let done = false; // true once the page's handshake has been answered

  const fail = (status, text) => {
    done = true;
    if (socket.destroyed) return;
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  const parsed = decodeWsPath(new URL(req.url, "http://localhost").pathname);
  if (!parsed) {
    o.log(400, req.url, "not a valid Kite WebSocket address");
    return fail(400, "Bad Request");
  }
  const { target, origin } = parsed;

  // Same checks as page requests: ws:// is http://, wss:// is https://.
  try {
    checkTarget(new URL(target.href.replace(/^ws/i, "http")), o);
  } catch (err) {
    o.log(403, target.href, err.message);
    return fail(403, "Forbidden");
  }

  const secure = target.protocol === "wss:";
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || (secure ? 443 : 80));
  const base = { host, port, lookup: guardedLookup(o.allowPrivate) };
  const up = secure
    ? tls.connect({ ...base, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ["http/1.1"] })
    : net.connect(base);

  const timer = setTimeout(() => {
    up.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
  }, CONNECT_TIMEOUT_MS);

  socket.on("error", () => up.destroy());
  socket.on("close", () => up.destroy());
  up.on("close", () => {
    clearTimeout(timer);
    if (done) socket.destroy();
  });
  up.on("error", (err) => {
    clearTimeout(timer);
    if (done) return socket.destroy();
    const blockedTarget = err.code === "KITE_BLOCKED";
    o.log(blockedTarget ? 403 : 502, target.href, blockedTarget ? err.message : err.code || err.message);
    fail(blockedTarget ? 403 : 502, blockedTarget ? "Forbidden" : "Bad Gateway");
  });

  // 1. Send the handshake to the real site.
  up.once(secure ? "secureConnect" : "connect", () => {
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
    ];
    for (const h of PASS_TO_SITE) if (req.headers[h]) lines.push(`${h}: ${req.headers[h]}`);
    if (origin) lines.push(`Origin: ${origin}`); // the real page's origin, which sites often check
    for (const [k, v] of Object.entries(o.extraHeaders ? o.extraHeaders(target) : {})) lines.push(`${k}: ${v}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
  });

  // 2. Read the site's reply, pass the safe parts back to the page, then relay frames.
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buf.length > MAX_HANDSHAKE) up.destroy(new Error("handshake reply too large"));
      return;
    }
    up.removeListener("data", onData);
    clearTimeout(timer);

    const [statusLine, ...headerLines] = buf.subarray(0, end).toString("latin1").split("\r\n");
    const rest = buf.subarray(end + 4);
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]) || 0;
    if (status !== 101) {
      o.log(status || 502, target.href, "the site refused the WebSocket", "upstream");
      fail(502, "Bad Gateway");
      return up.destroy();
    }

    const reply = ["HTTP/1.1 101 Switching Protocols"];
    const responseHeaders = [];
    for (const line of headerLines) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const name = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      responseHeaders.push([name, value]);
      if (PASS_TO_PAGE.includes(name)) reply.push(`${name}: ${value}`);
    }
    if (o.onResponseHeaders) o.onResponseHeaders(target, responseHeaders);

    done = true;
    socket.write(reply.join("\r\n") + "\r\n\r\n");
    if (rest.length) socket.write(rest);
    socket.setNoDelay(true);
    up.setNoDelay(true);
    up.pipe(socket);
    socket.pipe(up);
  };
  up.on("data", onData);
}
