// Kite's cookie jar (Stage 4). No dependencies.
//
// Websites' cookies never reach your real browser: the backend keeps one jar per
// Kite session and plays the browser's part, following the same rules browsers
// use (RFC 6265): domain and path matching, Secure, HttpOnly, expiry, SameSite,
// and the __Secure- / __Host- prefixes.

// Suffixes under which anyone can register a site. A cookie may not be set for
// these (otherwise one site could set cookies for every other site under them).
// This is a short built-in list, not the full Public Suffix List.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "com.au", "net.au", "org.au", "edu.au",
  "co.jp", "ne.jp", "or.jp", "co.nz", "org.nz", "com.br", "com.cn", "com.hk", "com.tw", "co.in",
  "co.kr", "com.mx", "com.tr", "co.za", "com.sg", "com.ar", "co.id", "com.my", "com.ph", "com.vn",
]);
const SHARED_HOSTING_SUFFIXES = new Set([
  "github.io", "app.github.dev", "githubpreview.dev", "vercel.app", "netlify.app", "pages.dev",
  "workers.dev", "herokuapp.com", "appspot.com", "web.app", "firebaseapp.com", "blogspot.com",
  "azurewebsites.net", "cloudfront.net", "onrender.com", "fly.dev", "glitch.me", "repl.co",
]);

const MAX_COOKIE_BYTES = 4096;
const MAX_PER_DOMAIN = 180;
const MAX_TOTAL = 3000;

const isIp = (host) => /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
const normHost = (host) => String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

export function isPublicSuffix(domain) {
  const d = normHost(domain);
  return !d.includes(".") || MULTI_PART_SUFFIXES.has(d) || SHARED_HOSTING_SUFFIXES.has(d);
}

// The "site" a host belongs to (example.co.uk for www.example.co.uk). Used for SameSite.
export function siteOf(host) {
  const h = normHost(host);
  if (isIp(h)) return h;
  const labels = h.split(".");
  for (let n = Math.min(labels.length, 4); n >= 2; n--) {
    const suffix = labels.slice(-n).join(".");
    if (MULTI_PART_SUFFIXES.has(suffix) || SHARED_HOSTING_SUFFIXES.has(suffix)) {
      return labels.slice(-(n + 1)).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

function domainMatch(host, cookie) {
  return cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith("." + cookie.domain);
}

function pathMatch(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

function defaultPath(url) {
  const p = url.pathname;
  if (!p.startsWith("/") || p.lastIndexOf("/") === 0) return "/";
  return p.slice(0, p.lastIndexOf("/"));
}

export class CookieJar {
  constructor() {
    this.cookies = new Map(); // "domain;path;name" -> cookie
  }

  get size() {
    this.#purge();
    return this.cookies.size;
  }

  // Store one Set-Cookie header (or one document.cookie assignment) received for url.
  // Returns true if the jar changed.
  set(setCookie, url, { fromScript = false } = {}) {
    url = new URL(url);
    const host = normHost(url.hostname);
    const secureUrl = url.protocol === "https:" || url.protocol === "wss:";
    const parts = String(setCookie).split(";");
    const first = parts.shift();
    const eq = first.indexOf("=");
    if (eq < 1) return false; // nameless cookies are ignored
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name || name.length + value.length > MAX_COOKIE_BYTES || /[\x00-\x1f\x7f]/.test(name + value)) return false;

    const attrs = {};
    for (const part of parts) {
      const i = part.indexOf("=");
      const key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
      if (key) attrs[key] = i < 0 ? "" : part.slice(i + 1).trim();
    }

    let domain = host;
    let hostOnly = true;
    if (attrs.domain) {
      const d = normHost(attrs.domain.replace(/^\./, ""));
      if (host !== d && !host.endsWith("." + d)) return false; // can't set cookies for other sites
      if (isIp(host) && host !== d) return false;
      if (isPublicSuffix(d)) {
        if (d !== host) return false;
      } else {
        domain = d;
        hostOnly = false;
      }
    }
    const path = attrs.path && attrs.path.startsWith("/") ? attrs.path : defaultPath(url);
    const secure = "secure" in attrs;
    if (secure && !secureUrl) return false;
    const httpOnly = "httponly" in attrs;
    if (fromScript && httpOnly) return false;
    let sameSite = (attrs.samesite || "lax").toLowerCase();
    if (!["strict", "lax", "none"].includes(sameSite)) sameSite = "lax";
    if (sameSite === "none" && !secure) sameSite = "lax";
    if (name.startsWith("__Secure-") && !secure) return false;
    if (name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/")) return false;

    let expires = null; // null = until the Kite session ends
    if (attrs["max-age"] !== undefined && /^-?\d+$/.test(attrs["max-age"])) {
      expires = Date.now() + Number(attrs["max-age"]) * 1000;
    } else if (attrs.expires) {
      const t = Date.parse(attrs.expires);
      if (!Number.isNaN(t)) expires = t;
    }

    const key = `${domain};${path};${name}`;
    const existing = this.cookies.get(key);
    if (existing && existing.httpOnly && fromScript) return false; // scripts can't touch HttpOnly cookies
    if (expires !== null && expires <= Date.now()) return this.cookies.delete(key); // deletion

    this.cookies.set(key, {
      name, value, domain, hostOnly, path, secure, httpOnly, sameSite, expires,
      created: existing ? existing.created : Date.now(),
    });
    this.#enforceLimits(domain);
    return true;
  }

  // Store every Set-Cookie header from a response.
  setAll(setCookies, url) {
    let changed = false;
    for (const c of [].concat(setCookies || [])) changed = this.set(c, url) || changed;
    return changed;
  }

  // The Cookie header to send with a request to url.
  //   crossSite:   the request was made by a page on a different site
  //   topLevel:    you navigated the tab yourself (typed an address or clicked a
  //                link) with a safe method (GET/HEAD)
  //   fromScript:  only cookies document.cookie may see (no HttpOnly)
  // Third-party cookies are blocked (as Safari and Firefox do): a cross-site
  // request that isn't your own navigation gets no cookies at all. In Kite every
  // site shares the backend's address, so this is what stops one site from
  // reading another site's logged-in pages through Kite.
  header(url, { crossSite = false, topLevel = true, fromScript = false } = {}) {
    if (crossSite && !topLevel) return "";
    url = new URL(url);
    const host = normHost(url.hostname);
    const secureUrl = url.protocol === "https:" || url.protocol === "wss:";
    const now = Date.now();
    const matches = [];
    for (const [key, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (!domainMatch(host, c) || !pathMatch(url.pathname || "/", c.path)) continue;
      if (c.secure && !secureUrl) continue;
      if (fromScript && c.httpOnly) continue;
      if (crossSite && c.sameSite === "strict") continue;
      matches.push(c);
    }
    matches.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return matches.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  // What document.cookie should show on a page at url.
  scriptCookies(url) {
    return this.header(url, { fromScript: true });
  }

  // { site: count } for the cookie manager page.
  summary() {
    this.#purge();
    const out = {};
    for (const c of this.cookies.values()) out[siteOf(c.domain)] = (out[siteOf(c.domain)] || 0) + 1;
    return out;
  }

  clear(site) {
    if (!site) return this.cookies.clear();
    for (const [key, c] of this.cookies) if (siteOf(c.domain) === site) this.cookies.delete(key);
  }

  toJSON() {
    this.#purge();
    return [...this.cookies.values()];
  }

  static fromJSON(list) {
    const jar = new CookieJar();
    for (const c of list || []) {
      if (c && c.name && c.domain && c.path) jar.cookies.set(`${c.domain};${c.path};${c.name}`, c);
    }
    jar.#purge();
    return jar;
  }

  #purge() {
    const now = Date.now();
    for (const [key, c] of this.cookies) if (c.expires !== null && c.expires <= now) this.cookies.delete(key);
  }

  #enforceLimits(domain) {
    const oldestFirst = (list) => list.sort((a, b) => a[1].created - b[1].created);
    const forDomain = oldestFirst([...this.cookies].filter(([, c]) => c.domain === domain));
    while (forDomain.length > MAX_PER_DOMAIN) this.cookies.delete(forDomain.shift()[0]);
    if (this.cookies.size > MAX_TOTAL) {
      const all = oldestFirst([...this.cookies]);
      while (all.length > MAX_TOTAL) this.cookies.delete(all.shift()[0]);
    }
  }
}

// Cookie context of a request made by `page` (the real URL of the page that made
// it, or null when it came from the Kite address bar) to `target`.
// Sec-Fetch-User: ?1 is set by the browser only when a person clicked or pressed
// something, so scripts and hidden iframes can't use it to borrow your cookies.
export function requestContext(page, target, req) {
  const mode = req.headers["sec-fetch-mode"];
  const dest = req.headers["sec-fetch-dest"];
  const safe = req.method === "GET" || req.method === "HEAD";
  const navigation = mode === "navigate" || dest === "document" || dest === "iframe";
  const yours = !page || req.headers["sec-fetch-user"] === "?1";
  return {
    crossSite: page ? siteOf(page.hostname) !== siteOf(new URL(target).hostname) : false,
    topLevel: navigation && safe && yours,
  };
}
