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

// The real URL of the proxied page that made this request (from its Referer), or null.
export function sourcePage(req) {
  try {
    const ref = new URL(req.headers.referer);
    if (!ref.pathname.startsWith(PREFIX)) return null;
    const real = decodeUrl(ref.pathname.slice(PREFIX.length).split("/")[0]);
    return real ? new URL(real) : null;
  } catch {
    return null;
  }
}

// If a page asks for a path we did not rewrite (e.g. one built by JavaScript),
// the Referer tells us which proxied page it came from, so resolve against it.
export function resolveViaReferer(req, relative) {
  const page = sourcePage(req);
  try {
    return page ? new URL(relative, page).href : null;
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

export function checkTarget(u, o) {
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
export function guardedLookup(allowPrivate) {
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
  // <meta name="referrer"> would override Kite's referrer policy and break requests.
  if (tag === "meta" && (get("name") || "").toLowerCase() === "referrer") return "";

  const out = [];
  for (const a of attrs) {
    const n = a.lname;
    if (a.value === null) {
      out.push(a.name);
      continue;
    }
    const dv = decodeEntities(a.value);
    let nv = null; // new (decoded) value, or null to keep the original
    if (n === "integrity" || n === "referrerpolicy") continue;
    if (n === "target" && /^_(blank|top|parent)$/i.test(dv.trim())) continue; // keep pages inside the tab
    if (URL_ATTRS.has(n) || (n === "data" && tag === "object")) nv = rewriteUrl(dv, state.base);
    else if (n === "srcset" || n === "imagesrcset") nv = rewriteSrcset(dv, state.base);
    else if (n === "style") nv = rewriteCss(dv, state.base);
    else if (n === "ping") nv = dv.split(/\s+/).filter(Boolean).map((u) => rewriteUrl(u, state.base)).join(" ");
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

// Runs inside every proxied page, before the page's own scripts (Stage 2).
// The page's JavaScript builds URLs while it runs, which the server never sees.
// This script catches those and sends them through Kite too:
//  - fetch, XMLHttpRequest, sendBeacon, EventSource, Worker, WebSocket (Stage 3)
//  - element URLs set from JavaScript (img.src, a.href, setAttribute...) and
//    elements inserted as HTML (innerHTML)
//  - navigation: link clicks, forms, location.href = ..., window.open
//  - history.pushState/replaceState, so the page keeps its Kite address
// It also tells the Kite UI the real URL and title, and lets the UI's
// back/forward/reload buttons control the tab.
function kiteClient(realUrl, origins) {
  if (window.__kite) return;
  window.__kite = true;
  var PREFIX = "/proxy/";
  var current = realUrl;
  var isTab = window.parent !== window && window.parent === window.top;
  var origSetAttribute = Element.prototype.setAttribute;

  // ---------- URL helpers ----------

  function encode(url) {
    var bytes = new TextEncoder().encode(url);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decode(token) {
    try {
      var bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var u = new URL(new TextDecoder().decode(bytes));
      return u.protocol === "http:" || u.protocol === "https:" ? u : null;
    } catch (e) {
      return null;
    }
  }
  // The real-site URL for any URL the page uses (relative, absolute, or already a
  // Kite URL), or null for things to leave alone (data:, blob:, #hash...).
  function realOf(url) {
    var s = String(url).trim();
    if (!s || s.charAt(0) === "#" || /^(?:data|blob|javascript|about|mailto|tel|sms):/i.test(s)) return null;
    var here = new URL(s, location.href);
    if (here.origin === location.origin) {
      if (here.pathname.indexOf(PREFIX) === 0) {
        var d = decode(here.pathname.slice(PREFIX.length).split("/")[0]);
        if (d) {
          if (here.search) d.search = here.search;
          d.hash = here.hash;
          return d;
        }
      }
      // An absolute URL built from location.origin really means the real site.
      if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return new URL(here.pathname + here.search + here.hash, current);
    }
    var real = new URL(s, current);
    return real.protocol === "http:" || real.protocol === "https:" ? real : null;
  }
  function proxyPath(real) {
    var u = new URL(real.href);
    var hash = u.hash;
    u.hash = "";
    return PREFIX + encode(u.href) + hash;
  }
  // Rewrite a URL to go through Kite; anything unexpected is returned unchanged.
  function wrap(url) {
    if (url === undefined || url === null) return url;
    var s = String(url);
    if (s.indexOf(PREFIX) === 0) return url; // already a Kite path
    try {
      var r = realOf(s);
      return r ? proxyPath(r) : url;
    } catch (e) {
      return url;
    }
  }
  function wrapSrcset(value) {
    return String(value)
      .split(/,\s+/)
      .map(function (part) {
        var bits = part.trim().split(/\s+/);
        bits[0] = wrap(bits[0]);
        return bits.join(" ");
      })
      .join(", ");
  }

  // ---------- talking to the Kite UI ----------

  function post(msg) {
    if (window.top === window) return;
    if (!origins.length) return window.top.postMessage(msg, "*");
    for (var i = 0; i < origins.length; i++) {
      try { window.top.postMessage(msg, origins[i]); } catch (e) {}
    }
  }
  function report() {
    if (isTab) post({ kite: 1, type: "page", url: current, title: document.title || "" });
  }
  function openTab(real) {
    post({ kite: 1, type: "open", url: real.href });
  }

  // ---------- network requests ----------

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof Request !== "undefined" && input instanceof Request) {
          var w = wrap(input.url);
          if (w !== input.url) input = new Request(w, input);
        } else {
          input = wrap(input);
        }
      } catch (e) {}
      return origFetch.call(window, input, init);
    };
  }

  var origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (args.length > 1) args[1] = wrap(url);
    return origXhrOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      return origBeacon.call(navigator, wrap(url), data);
    };
  }

  ["EventSource", "Worker", "SharedWorker"].forEach(function (name) {
    var Original = window[name];
    if (!Original) return;
    var Wrapped = function (url, options) {
      return new Original(wrap(url), options);
    };
    Wrapped.prototype = Original.prototype;
    Object.getOwnPropertyNames(Original).forEach(function (key) {
      if (/^(prototype|name|length|arguments|caller)$/.test(key)) return;
      try { Wrapped[key] = Original[key]; } catch (e) {}
    });
    window[name] = Wrapped;
  });

  // WebSockets (Stage 3) go through Kite's relay at /ws/<real url>/<page origin>.
  var OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    var wsRelayUrl = function (url) {
      var s = String(url);
      var u = new URL(s, current);
      // Built from location.host/origin? That really means the real site.
      if (u.host === location.host && u.pathname.indexOf("/ws/") !== 0) u = new URL(u.pathname + u.search, current);
      else if (u.host === location.host) return s; // already a Kite relay URL
      if (u.protocol === "http:") u.protocol = "ws:";
      else if (u.protocol === "https:") u.protocol = "wss:";
      if (u.protocol !== "ws:" && u.protocol !== "wss:") return s;
      u.hash = "";
      return (location.protocol === "https:" ? "wss://" : "ws://") + location.host +
        "/ws/" + encode(u.href) + "/" + encode(new URL(current).origin);
    };
    var KiteWebSocket = function (url, protocols) {
      var relay = url;
      try { relay = wsRelayUrl(url); } catch (e) {}
      return protocols === undefined ? new OrigWebSocket(relay) : new OrigWebSocket(relay, protocols);
    };
    KiteWebSocket.prototype = OrigWebSocket.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { KiteWebSocket[k] = OrigWebSocket[k]; });
    window.WebSocket = KiteWebSocket;
  }

  // A site's own service worker would be installed on Kite's address and take over
  // every Kite request (YouTube tries this), so refuse politely.
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    try {
      Object.getPrototypeOf(navigator.serviceWorker).register = function () {
        return Promise.reject(new DOMException("Service workers are disabled in Kite", "SecurityError"));
      };
    } catch (e) {}
  }

  // ---------- URLs set on elements from JavaScript ----------

  function hook(Ctor, prop, fn) {
    if (!Ctor) return;
    var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!d || !d.set || !d.configurable) return;
    Object.defineProperty(Ctor.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function (v) { d.set.call(this, fn(v)); },
    });
  }
  [
    ["HTMLImageElement", "src"], ["HTMLScriptElement", "src"], ["HTMLLinkElement", "href"],
    ["HTMLIFrameElement", "src"], ["HTMLFrameElement", "src"], ["HTMLSourceElement", "src"],
    ["HTMLMediaElement", "src"], ["HTMLEmbedElement", "src"], ["HTMLObjectElement", "data"],
    ["HTMLAnchorElement", "href"], ["HTMLAreaElement", "href"], ["HTMLFormElement", "action"],
    ["HTMLInputElement", "src"], ["HTMLInputElement", "formAction"], ["HTMLButtonElement", "formAction"],
    ["HTMLTrackElement", "src"], ["HTMLVideoElement", "poster"],
  ].forEach(function (p) { hook(window[p[0]], p[1], wrap); });
  hook(window.HTMLImageElement, "srcset", wrapSrcset);
  hook(window.HTMLSourceElement, "srcset", wrapSrcset);

  var URL_ATTRS = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, data: 1, srcset: 2, imagesrcset: 2 };
  function fixAttr(el, name, value) {
    var kind = URL_ATTRS[name];
    if (!kind || el.namespaceURI !== "http://www.w3.org/1999/xhtml") return value;
    if (name === "data" && el.tagName !== "OBJECT") return value;
    return kind === 2 ? wrapSrcset(value) : wrap(value);
  }
  Element.prototype.setAttribute = function (name, value) {
    return origSetAttribute.call(this, name, fixAttr(this, String(name).toLowerCase(), value));
  };

  // Elements added as HTML (innerHTML, insertAdjacentHTML...) never pass through
  // the setters above, so fix their URLs as they arrive.
  var SELECTOR = "img,source,iframe,frame,embed,object,video,audio,track,link,a,area,form,input";
  function fixElement(el) {
    for (var name in URL_ATTRS) {
      var v = el.getAttribute(name);
      if (v === null) continue;
      var nv = fixAttr(el, name, v);
      if (nv !== v) origSetAttribute.call(el, name, nv);
    }
  }
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var nodes = records[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.nodeType !== 1) continue;
        if (n.matches(SELECTOR)) fixElement(n);
        var inner = n.querySelectorAll(SELECTOR);
        for (var k = 0; k < inner.length; k++) fixElement(inner[k]);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- navigation ----------

  var origOpen = window.open;
  window.open = function (url, target) {
    var real = null;
    try { real = url ? realOf(url) : null; } catch (e) {}
    if (!real) return origOpen.apply(window, arguments);
    var t = String(target || "_blank").toLowerCase();
    if (t === "_self" || t === "_top" || t === "_parent") {
      location.assign(proxyPath(real));
      return window;
    }
    openTab(real); // a new Kite tab instead of a real browser window
    return null;
  };

  // Links that point off Kite (or ask for a new window).
  window.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href],area[href]") : null;
    if (!a || a.hasAttribute("download")) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    var real = null;
    try { real = realOf(href); } catch (err) {}
    if (!real) return;
    var newTab = (a.getAttribute("target") || "").toLowerCase() === "_blank" || e.ctrlKey || e.metaKey || e.shiftKey;
    var offsite = new URL(a.href, location.href).origin !== location.origin;
    if (!newTab && !offsite) return;
    e.preventDefault();
    if (newTab) openTab(real);
    else location.assign(proxyPath(real));
  });

  // Forms whose action was changed after the page loaded.
  window.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM") return;
    var act = f.getAttribute("action");
    if (act) {
      var w = wrap(act);
      if (w !== act) origSetAttribute.call(f, "action", w);
    }
  }, true);

  // Anything else that would leave the tab's Kite address: location.href = "...",
  // location.assign("/results?..."), form.submit() to another site...
  // (Navigation API; Chromium-based browsers.)
  if (window.navigation && window.navigation.addEventListener) {
    window.navigation.addEventListener("navigate", function (e) {
      if (!e.cancelable || e.downloadRequest || e.hashChange || e.navigationType === "traverse") return;
      var dest;
      try { dest = new URL(e.destination.url); } catch (err) { return; }
      if (dest.origin === location.origin && dest.pathname.indexOf(PREFIX) === 0) return; // already Kite
      var real = null;
      try { real = realOf(dest.href); } catch (err) {}
      if (!real) return;
      e.preventDefault();
      var path = proxyPath(real);
      if (!e.formData) return location.assign(path);
      var form = document.createElement("form");
      form.method = "post";
      origSetAttribute.call(form, "action", path);
      form.style.display = "none";
      e.formData.forEach(function (v, k) {
        if (typeof v !== "string") return;
        var input = document.createElement("input");
        input.type = "hidden";
        input.name = k;
        input.value = v;
        form.appendChild(input);
      });
      document.body.appendChild(form);
      HTMLFormElement.prototype.submit.call(form);
    });
  }

  // ---------- history: keep the tab on its Kite address ----------

  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    history[name] = function (state, title, url) {
      if (url !== undefined && url !== null && url !== "") {
        var real = null;
        try { real = realOf(url); } catch (e) {}
        if (real) {
          current = real.href;
          url = proxyPath(real);
        }
      }
      var result = original.call(this, state, title, url);
      report();
      return result;
    };
  });

  function syncFromLocation() {
    var d = decode(location.pathname.slice(PREFIX.length).split("/")[0]);
    if (d) {
      d.search = location.search || d.search;
      d.hash = location.hash;
      current = d.href;
    }
    report();
  }
  window.addEventListener("popstate", syncFromLocation);
  window.addEventListener("hashchange", syncFromLocation);

  // ---------- Kite UI ----------

  if (isTab) {
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

// Request headers never passed on to the website: connection plumbing, headers
// Kite sets itself, your cookies, and anything that could reveal your IP address.
// Everything else (including custom headers that sites' own JavaScript adds,
// like API keys and client versions) is forwarded.
const NO_FORWARD = new Set([
  "host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "cookie", "referer", "origin", "accept-encoding",
  "sec-fetch-site", "sec-fetch-dest", "forwarded", "via", "x-real-ip", "x-client-ip",
  "true-client-ip", "cdn-loop",
]);
const NO_FORWARD_PREFIX = /^(x-forwarded-|cf-|x-arr-|x-original-|x-ms-|x-envoy-|x-github-|x-kite-)/;

// Make the request look to the site like it came straight from the real page:
// the real page as Referer/Origin, and matching Sec-Fetch-* headers. Many sites
// return 403 for images, stylesheets or pings that arrive without them.
function upstreamHeaders(req, target) {
  const h = { "accept-encoding": "gzip, deflate, br" };
  for (const [name, value] of Object.entries(req.headers)) {
    if (!NO_FORWARD.has(name) && !NO_FORWARD_PREFIX.test(name)) h[name] = value;
  }
  const page = sourcePage(req);
  const dest = req.headers["sec-fetch-dest"];
  if (dest) h["sec-fetch-dest"] = dest === "iframe" && !page ? "document" : dest; // a Kite tab is a normal page to the site
  if (page) {
    const same = page.origin === target.origin;
    h.referer = same ? page.href : page.origin + "/";
    if (req.headers["sec-fetch-site"]) h["sec-fetch-site"] = same ? "same-origin" : "cross-site";
    if (req.headers.origin) h.origin = page.origin;
  } else if (req.headers["sec-fetch-site"]) {
    h["sec-fetch-site"] = "none"; // typed into the address bar
  }
  return h;
}

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
  out["x-kite-source"] = "upstream"; // this response came from the website
  return out;
}

function fetchUpstream(target, req, o) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const headers = upstreamHeaders(req, u);
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
  res.setHeader("x-kite-source", "kite"); // visible to the server's error log
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-kite-source": "kite" });
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
      res.writeHead(307, { location: toProxyUrl(abs), "x-kite-source": "kite" });
      return res.end();
    }
    if (reqUrl.search) {
      // GET forms replace the query string of their action URL.
      const t = new URL(target);
      t.search = reqUrl.search;
      target = t.href;
    }

    // A tab's first load comes from the Kite UI, on another origin. If the site
    // redirects (youtube.com -> www.youtube.com), browsers may drop the Referer on
    // the next hop and the backend would refuse it, so follow those redirects here.
    const followRedirects = !sourcePage(req) && (req.method === "GET" || req.method === "HEAD");
    let up;
    for (let hops = 0; ; hops++) {
      checkTarget(new URL(target), o); // every hop goes through the SSRF checks
      up = await fetchUpstream(target, req, o);
      const loc = up.headers.location;
      if (!followRedirects || hops >= 10 || up.statusCode < 300 || up.statusCode >= 400 || !loc) break;
      let next;
      try {
        next = new URL(loc, target);
      } catch {
        break;
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") break;
      up.resume();
      target = next.href;
    }
    const status = up.statusCode;
    const headers = cleanHeaders(up.headers);
    res.setHeader("x-kite-source", "upstream"); // visible to the server's error log

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
      // Browsers apply a redirect's Referrer-Policy to the next request. "same-origin"
      // here would strip the Referer the backend uses to allow the first page load.
      delete headers["referrer-policy"];
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
