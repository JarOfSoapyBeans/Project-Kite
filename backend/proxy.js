// Kite's own proxy engine (Stage 1). No dependencies.
// The browser loads /proxy/<base64url of the real URL>. This module fetches the
// real page, rewrites every URL in the HTML/CSS so it points back at /proxy/,
// strips headers that would block it, and injects a tiny script that tells the
// Kite UI which page is showing.

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import { promisify } from "node:util";

export const PREFIX = "/proxy/";
const MAX_BODY = 10 * 1024 * 1024; // largest HTML/CSS we will rewrite, and largest upload
const TIMEOUT_MS = 30_000;

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotli = promisify(zlib.brotliDecompress);

// ---------- URL encoding ----------

export function encodeUrl(url) {
  return Buffer.from(url, "utf8").toString("base64url");
}

export function decodeUrl(token) {
  try {
    const u = new URL(Buffer.from(token, "base64url").toString("utf8"));
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function toProxyUrl(absolute) {
  const u = new URL(absolute);
  const hash = u.hash;
  u.hash = "";
  return PREFIX + encodeUrl(u.href) + hash;
}

// Resolve a URL found in a page and turn it into a /proxy/ URL.
// Leaves data:, javascript:, mailto:, #fragments etc. alone.
export function rewriteUrl(value, base) {
  const v = value.trim();
  if (!v || v.startsWith("#")) return value;
  if (/^(?:data|javascript|mailto|tel|sms|blob|about|file):/i.test(v)) return value;
  try {
    const abs = new URL(v, base);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return value;
    return toProxyUrl(abs.href);
  } catch {
    return value;
  }
}

// If a page asks for a path we did not rewrite (e.g. one built by JavaScript),
// the Referer tells us which proxied page it came from, so resolve against it.
export function resolveViaReferer(req, relative) {
  try {
    const ref = new URL(req.headers.referer);
    if (!ref.pathname.startsWith(PREFIX)) return null;
    const base = decodeUrl(ref.pathname.slice(PREFIX.length).split("/")[0]);
    return base ? new URL(relative, base).href : null;
  } catch {
    return null;
  }
}

// ---------- SSRF protection ----------

function blockedV4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// True for loopback, private, link-local, multicast and other non-public addresses.
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return blockedV4(ip);
  if (!net.isIPv6(ip)) return true;
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blockedV4(mapped[1]);
  const mappedHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return blockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (s.startsWith("::")) return true; // ::, ::1, old IPv4-compatible forms
  if (s.startsWith("64:ff9b:")) return true; // NAT64 can wrap private IPv4
  const first = parseInt(s.split(":")[0], 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

function blocked(message) {
  return Object.assign(new Error(message), { code: "KITE_BLOCKED" });
}

function checkTarget(u, o) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw blocked("Only http and https are allowed.");
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (o.allowedPorts && !o.allowedPorts.includes(port)) throw blocked(`Port ${port} is not allowed.`);
  if (o.allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw blocked("Local addresses are not allowed.");
  if (net.isIP(host) && isBlockedAddress(host)) throw blocked("Private and local addresses are not allowed.");
}

// Checks the address DNS actually returned, at connect time, so a public
// hostname that resolves to a private IP is still blocked.
function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      if (!allowPrivate && list.some((a) => isBlockedAddress(a.address))) {
        return callback(blocked(`${hostname} resolves to a private or local address.`));
      }
      callback(null, address, family);
    });
  };
}

// ---------- CSS rewriting ----------

export function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi, (m, a, b, c) => {
      const out = rewriteUrl(a ?? b ?? c ?? "", base);
      return `url("${out.replace(/"/g, "%22")}")`;
    })
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (m, a, b) => `@import "${rewriteUrl(a ?? b, base)}"`);
}

// ---------- HTML rewriting ----------

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    const code = l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rewriteSrcset(value, base) {
  const out = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(value[i])) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !/\s/.test(value[i])) i++;
    let url = value.slice(start, i);
    let desc = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const ds = i;
      let depth = 0;
      while (i < n && !(value[i] === "," && depth === 0)) {
        if (value[i] === "(") depth++;
        else if (value[i] === ")") depth--;
        i++;
      }
      desc = value.slice(ds, i).trim();
    }
    out.push(rewriteUrl(url, base) + (desc ? " " + desc : ""));
  }
  return out.join(", ");
}

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "background", "cite", "longdesc", "manifest", "icon"]);
const DROP_META = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options"]);

function rewriteTag(name, attrStr, state) {
  const tag = name.toLowerCase();
  const attrs = [...attrStr.matchAll(ATTR_RE)].map((m) => ({
    name: m[1],
    lname: m[1].toLowerCase(),
    value: m[2] ?? m[3] ?? m[4] ?? null,
  }));
  const get = (n) => attrs.find((a) => a.lname === n)?.value ?? null;

  if (tag === "base") {
    const href = get("href");
    if (href !== null) {
      try {
        state.base = new URL(decodeEntities(href), state.base).href;
      } catch {}
    }
    return ""; // remove: we already made every URL absolute
  }
  const httpEquiv = tag === "meta" ? (get("http-equiv") || "").toLowerCase() : "";
  if (DROP_META.has(httpEquiv)) return "";

  const out = [];
  for (const a of attrs) {
    const n = a.lname;
    if (a.value === null) {
      out.push(a.name);
      continue;
    }
    const dv = decodeEntities(a.value);
    let nv = null; // new (decoded) value, or null to keep the original
    if (n === "integrity" || n === "ping") continue;
    if (n === "target" && /^_(blank|top|parent)$/i.test(dv.trim())) continue; // keep pages inside the tab
    if (URL_ATTRS.has(n) || (n === "data" && tag === "object")) nv = rewriteUrl(dv, state.base);
    else if (n === "srcset" || n === "imagesrcset") nv = rewriteSrcset(dv, state.base);
    else if (n === "style") nv = rewriteCss(dv, state.base);
    else if (n === "content" && httpEquiv === "refresh") {
      nv = dv.replace(/(url\s*=\s*)(['"]?)([^'";]+)\2/i, (m, p, q, u) => p + q + rewriteUrl(u.trim(), state.base) + q);
    }
    out.push(nv === null ? `${a.name}="${a.value.replace(/"/g, "&quot;")}"` : `${a.name}="${escapeAttr(nv)}"`);
  }
  const selfClose = /\/\s*$/.test(attrStr) ? " /" : "";
  return `<${name}${out.length ? " " + out.join(" ") : ""}${selfClose}>`;
}

// Comments | <script>/<style> with their contents | any other start tag
const SCAN = /<!--[\s\S]*?-->|<(script|style)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

export function rewriteHtml(html, pageUrl, { allowedOrigins = [] } = {}) {
  const state = { base: pageUrl };
  let out = html.replace(SCAN, (m, sName, sAttrs, sBody, tName, tAttrs) => {
    if (m.startsWith("<!--")) return m;
    if (sName) {
      const body = sName.toLowerCase() === "style" ? rewriteCss(sBody, state.base) : sBody;
      return rewriteTag(sName, sAttrs, state) + body + `</${sName}>`;
    }
    return rewriteTag(tName, tAttrs, state);
  });

  const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const inject = `<script data-kite>(${kiteClient.toString()})(${json(pageUrl)},${json(allowedOrigins)});</script>`;
  const head = /<head\b[^>]*>/i.exec(out);
  const at = head ? head.index + head[0].length : /^\s*(?:<!doctype[^>]*>)?/i.exec(out)[0].length;
  return out.slice(0, at) + inject + out.slice(at);
}

// Runs inside every proxied page. Tells the Kite UI the real URL and title,
// and lets the UI's back/forward/reload buttons control the tab.
function kiteClient(realUrl, origins) {
  if (window.__kite) return;
  window.__kite = true;
  var parent = window.parent;
  if (parent !== window && parent === window.top) {
    var report = function () {
      var msg = { kite: 1, type: "page", url: realUrl, title: document.title || "" };
      if (!origins.length) return parent.postMessage(msg, "*");
      for (var i = 0; i < origins.length; i++) {
        try { parent.postMessage(msg, origins[i]); } catch (e) {}
      }
    };
    report();
    document.addEventListener("DOMContentLoaded", report);
    window.addEventListener("load", report);
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.kite !== 1) return;
    if (d.cmd === "back") history.back();
    else if (d.cmd === "forward") history.forward();
    else if (d.cmd === "reload") location.reload();
  });
}

// ---------- fetching ----------

const FORWARD_HEADERS = ["user-agent", "accept", "accept-language", "content-type", "range"];

const DROP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "set-cookie", "set-cookie2", "content-security-policy",
  "content-security-policy-report-only", "x-frame-options", "strict-transport-security",
  "clear-site-data", "cross-origin-embedder-policy", "cross-origin-opener-policy",
  "cross-origin-resource-policy", "report-to", "nel", "link", "refresh", "content-location",
  "alt-svc", "permissions-policy", "feature-policy", "origin-agent-cluster", "referrer-policy",
]);

function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!DROP_HEADERS.has(k) && !k.startsWith("access-control-")) out[k] = v;
  }
  out["referrer-policy"] = "same-origin"; // keeps the Referer fallback working
  return out;
}

function fetchUpstream(target, req, o) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const headers = { "accept-encoding": "gzip, deflate, br" };
    for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    const up = (u.protocol === "https:" ? https : http).request(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: req.method,
        headers,
        lookup: guardedLookup(o.allowPrivate),
      },
      resolve
    );
    up.setTimeout(TIMEOUT_MS, () => up.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    up.on("error", reject);
    if (req.method === "GET" || req.method === "HEAD") return up.end();
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) up.destroy(new Error("request body too large"));
    });
    req.pipe(up);
  });
}

function readLimited(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error("page too large to rewrite"));
      } else chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function decodeBody(buf, encoding) {
  const e = String(encoding || "").toLowerCase().trim();
  const opts = { maxOutputLength: MAX_BODY * 2 };
  if (!e || e === "identity") return buf;
  if (e === "gzip" || e === "x-gzip") return gunzip(buf, opts);
  if (e === "br") return brotli(buf, opts);
  if (e === "deflate") return inflate(buf, opts).catch(() => inflateRaw(buf, opts));
  throw new Error(`unsupported content-encoding "${e}"`);
}

function decodeText(buf, contentType, isHtml) {
  let label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!label && isHtml) {
    label = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(buf.subarray(0, 2048).toString("latin1"))?.[1];
  }
  try {
    return new TextDecoder(label || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

function sendError(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Kite: ${status}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;padding:2rem;background:#16181d;color:#e6e8ec">` +
      `<h1 style="font-weight:600">Kite couldn't load this page</h1><p>${escapeHtml(message)}</p>`
  );
}

// options: allowPrivate (tests only), allowedPorts (array, or null for any), allowedOrigins
export async function handleProxy(req, res, options = {}) {
  const o = { allowPrivate: false, allowedPorts: [80, 443, 8080, 8443], allowedOrigins: [], ...options };
  let target;
  try {
    const reqUrl = new URL(req.url, "http://localhost");
    const rest = reqUrl.pathname.slice(PREFIX.length);
    target = decodeUrl(rest.split("/")[0]);

    if (!target) {
      // A relative URL resolved against /proxy/<token>; recover it from the Referer.
      const abs = resolveViaReferer(req, rest + reqUrl.search);
      if (!abs) return sendError(res, 400, "That isn't a valid Kite address.");
      res.writeHead(307, { location: toProxyUrl(abs) });
      return res.end();
    }
    if (reqUrl.search) {
      // GET forms replace the query string of their action URL.
      const t = new URL(target);
      t.search = reqUrl.search;
      target = t.href;
    }

    checkTarget(new URL(target), o);
    const up = await fetchUpstream(target, req, o);
    const status = up.statusCode;
    const headers = cleanHeaders(up.headers);

    if (status >= 300 && status < 400 && up.headers.location) {
      up.resume();
      let next;
      try {
        next = new URL(up.headers.location, target);
      } catch {
        return sendError(res, 502, "The site sent an invalid redirect.");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return sendError(res, 502, `The site redirected to an unsupported address (${next.protocol}).`);
      }
      headers.location = toProxyUrl(next.href);
      delete headers["content-length"];
      res.writeHead(status, headers);
      return res.end();
    }

    const type = String(up.headers["content-type"] || "").toLowerCase();
    const isHtml = /^(text\/html|application\/xhtml\+xml)\b/.test(type);
    const isCss = /^text\/css\b/.test(type);

    if ((!isHtml && !isCss) || req.method === "HEAD" || status === 204 || status === 304) {
      // Images, scripts, fonts, video...: stream through untouched.
      res.writeHead(status, headers);
      up.on("error", () => res.destroy());
      res.on("close", () => up.destroy());
      return up.pipe(res);
    }

    const raw = await readLimited(up, MAX_BODY);
    const text = decodeText(await decodeBody(raw, up.headers["content-encoding"]), type, isHtml);
    const body = Buffer.from(
      isHtml ? rewriteHtml(text, target, { allowedOrigins: o.allowedOrigins }) : rewriteCss(text, target),
      "utf8"
    );
    for (const h of ["content-encoding", "content-length", "etag", "last-modified", "accept-ranges", "content-range"]) {
      delete headers[h];
    }
    headers["content-type"] = `${isHtml ? "text/html" : "text/css"}; charset=utf-8`;
    headers["cache-control"] = "no-cache";
    headers["content-length"] = body.length;
    res.writeHead(status, headers);
    res.end(body);
  } catch (err) {
    if (err.code === "KITE_BLOCKED") return sendError(res, 403, err.message);
    let host = "the site";
    try {
      host = new URL(target).host;
    } catch {}
    sendError(res, 502, `Couldn't reach ${host}: ${err.code || err.message}`);
  }
}
