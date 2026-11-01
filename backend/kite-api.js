// Kite's own endpoints under /__kite/ (Stage 4). No dependencies.
//
//   POST /__kite/cookie            document.cookie writes from a proxied page
//   POST /__kite/report            the browser's reports (e.g. a page crashed), printed
//   POST /__kite/log               errors and navigations on a proxied page, printed
//                                  in the backend's window (KITE_PAGE_LOG=0 turns off)
//   GET  /__kite/cookies           which sites you have cookies for   (Kite UI only)
//   POST /__kite/cookies/clear     forget cookies (all, or one site)  (Kite UI only)
//   POST /__kite/cookies/import    add cookies exported from a browser (Kite UI only)
//   GET  /__kite/ticket            a pass for loading pages in tabs   (Kite UI only)
//   GET  /__kite/account           who is signed in                   (Kite UI only)
//   POST /__kite/account/signup    create a Kite account and sign in  (Kite UI only)
//   POST /__kite/account/signin    sign in                            (Kite UI only)
//   POST /__kite/account/signout   back to a guest session            (Kite UI only)
//   POST /__kite/account/google    collect a finished Google sign-in  (Kite UI only)
//   GET  /__kite/google/start, /__kite/google/callback   the Google sign-in popup (google.js)
//   GET  /__kite/data              your account's history, bookmarks, shortcuts, settings
//   GET  /__kite/data/versions     just their versions (for "has anything changed?")
//   PUT  /__kite/data/<name>       save one of them ({ value, base })     (signed-in Kite UI,
//                                  or a linked Kite app with its token)
//   POST /__kite/sync/link-code    a one-time code to link the Kite app  (signed-in Kite UI)
//   GET  /__kite/sync/devices      linked apps; POST /__kite/sync/unlink  (signed-in Kite UI)
//   POST /__kite/sync/token        the app trades a code for its token   (anyone, rate limited)
//   POST /__kite/sync/unlink-self  the app unlinks itself                (its token)
//   POST /__kite/account/signout-everywhere                           (Kite UI only)
//
// Proxied pages all live on the backend's address, so the cookie manager only
// answers cross-origin requests from your Kite frontend (ALLOWED_ORIGINS), never
// a page Kite is showing.

import { sourcePage } from "./proxy.js";
import { parseCookieExport, siteOf } from "./cookies.js";
import { googleConfig, handleGoogle, takeGoogleResult } from "./google.js";
import { ACCOUNT_DATA, putData, getData, getVersions, newLinkCode, useLinkCode, newToken, devices, unlink, resetLinkCodes, hashToken } from "./accountdata.js";

const GOOGLE = googleConfig();

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

// Slowing down password guessing: after 5 wrong tries from one address, or for
// one username, each further try waits longer (30 s, 1 min, 2 min, ... 15 min).
const failures = new Map(); // "ip:..." or "user:..." -> { count, until }
function lockedFor(key) {
  const f = failures.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function failed(key) {
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (f.count - 5)) * 1000;
  failures.set(key, f);
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
}
// New accounts: at most 5 per address per hour.
const signups = new Map(); // ip -> [times]
function signupAllowed(ip) {
  const now = Date.now();
  const list = (signups.get(ip) || []).filter((t) => now - t < 3600_000);
  signups.set(ip, list);
  return list.length < 5;
}
// Linking the app: at most 10 code tries per address per 10 minutes.
const codeTries = new Map(); // ip -> [times]
function codeTryAllowed(ip) {
  const now = Date.now();
  const list = (codeTries.get(ip) || []).filter((t) => now - t < 600_000);
  list.push(now);
  codeTries.set(ip, list);
  return list.length <= 10;
}

// For tests.
export function resetLimits() {
  failures.clear();
  signups.clear();
  codeTries.clear();
  resetLinkCodes();
}

// The Kite app (a linked device) proves who it is with "Authorization: Bearer <token>".
function bearer(req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ""));
  return m ? m[1] : null;
}
const SIGNUP_ON = process.env.KITE_SIGNUP !== "0";

// GET /__kite/data, PUT /__kite/data/<name> for one account.
async function dataEndpoint(req, res, pathname, account, sessions, cors) {
  const json = (status, value) => send(res, status, JSON.stringify(value), { ...cors, "content-type": "application/json" });
  if (pathname === "/__kite/data") return json(200, getData(account));
  if (pathname === "/__kite/data/versions") return json(200, getVersions(account));
  const name = pathname.slice("/__kite/data/".length);
  if (!ACCOUNT_DATA.has(name)) return json(404, { error: "unknown data" });
  if (req.method === "GET") return json(200, (account.data && account.data[name]) || { value: null, updated: 0 });
  if (req.method !== "PUT") return send(res, 405, "", cors);
  const text = await readBody(req, 5 * 1024 * 1024);
  if (text === null) return json(413, { error: "too big" });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "not JSON" });
  }
  const r = putData(account, name, body.value, body.base);
  if (r.error) return json(400, { error: r.error });
  sessions.changed();
  return json(200, r.merged ? { updated: r.updated, value: r.value } : { updated: r.updated });
}

const hashTokenOf = (t) => hashToken(t);

// Returns true if the request was a /__kite/ request (and has been answered).
export async function handleKiteApi(req, res, { sessions, allowedOrigins = [], clientIp = "unknown" }) {
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

  // The Google sign-in popup (checks its own callers; see google.js).
  if (pathname === "/__kite/google/start" || pathname === "/__kite/google/callback") {
    await handleGoogle(req, res, { allowedOrigins, config: GOOGLE });
    return true;
  }

  // ---------- the Kite app (linked with a token) ----------
  const token = bearer(req);
  if (pathname === "/__kite/sync/token") {
    if (req.method !== "POST") return send(res, 405), true;
    if (!codeTryAllowed(clientIp)) return send(res, 429, JSON.stringify({ error: "Too many tries. Wait a few minutes." }), { "content-type": "application/json" }), true;
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 2048)) || "{}");
    } catch {}
    const user = useLinkCode(body.code);
    const account = sessions.account(user);
    if (!account) return send(res, 400, JSON.stringify({ error: "That code is wrong or has expired. Make a new one in Kite Web." }), { "content-type": "application/json" }), true;
    const t = newToken(account, body.device);
    sessions.changed();
    console.log(`[info] Kite app linked to account ${sessions.displayName(user)}`);
    return send(res, 200, JSON.stringify({ token: t, user: sessions.displayName(user) }), { "content-type": "application/json" }), true;
  }
  if (token && (pathname === "/__kite/data" || pathname.startsWith("/__kite/data/") || pathname === "/__kite/sync/unlink-self")) {
    const user = sessions.userForToken(token);
    const account = sessions.account(user);
    if (!account) return send(res, 401, JSON.stringify({ error: "This app isn't linked any more." }), { "content-type": "application/json" }), true;
    if (pathname === "/__kite/sync/unlink-self") {
      account.tokens = (account.tokens || []).filter((t) => t.hash !== hashTokenOf(token));
      sessions.changed();
      return send(res, 204), true;
    }
    return dataEndpoint(req, res, pathname, account, sessions, {}), true;
  }

  // The cookie manager: only for the Kite UI.
  if (pathname === "/__kite/cookies" || pathname === "/__kite/cookies/clear" || pathname === "/__kite/cookies/import" ||
    pathname === "/__kite/ticket" || pathname === "/__kite/account" || pathname.startsWith("/__kite/account/") ||
    pathname === "/__kite/data" || pathname.startsWith("/__kite/data/") || pathname.startsWith("/__kite/sync/")) {
    const origin = req.headers.origin;
    let fromUi = false;
    try {
      fromUi = allowedOrigins.length ? allowedOrigins.includes(origin) : new URL(origin).host !== req.headers.host;
    } catch {}
    const cors = fromUi ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {};
    if (req.method === "OPTIONS") {
      return send(res, fromUi ? 204 : 403, "", { ...cors, "access-control-allow-methods": "GET, POST, PUT", "access-control-allow-headers": "content-type" }), true;
    }
    if (!fromUi) return send(res, 403, "Only the Kite UI can manage cookies."), true;
    const json = (status, value) => send(res, status, JSON.stringify(value), { ...cors, "content-type": "application/json" });
    // Your account's data, and linking the app (signed in only).
    if (pathname === "/__kite/data" || pathname.startsWith("/__kite/data/") || pathname.startsWith("/__kite/sync/")) {
      const user = sessions.userOf(req);
      const account = sessions.account(user);
      if (!account) return json(401, { error: "Sign in to your Kite account first." }), true;
      if (pathname === "/__kite/sync/link-code") {
        if (req.method !== "POST") return send(res, 405, "", cors), true;
        return json(200, newLinkCode(user)), true;
      }
      if (pathname === "/__kite/sync/devices") return json(200, { devices: devices(account) }), true;
      if (pathname === "/__kite/sync/unlink") {
        if (req.method !== "POST") return send(res, 405, "", cors), true;
        let body = {};
        try {
          body = JSON.parse((await readBody(req, 1024)) || "{}");
        } catch {}
        unlink(account, String(body.id || ""));
        sessions.changed();
        return json(200, { devices: devices(account) }), true;
      }
      if (pathname.startsWith("/__kite/sync/")) return send(res, 404, "", cors), true;
      return dataEndpoint(req, res, pathname, account, sessions, cors), true;
    }
    if (pathname === "/__kite/account" || pathname.startsWith("/__kite/account/")) {
      if (pathname === "/__kite/account") {
        sessions.jarFor(req, res); // every visitor has a (guest) session
        return json(200, { user: sessions.displayName(sessions.userOf(req)), signup: SIGNUP_ON, google: GOOGLE.enabled }), true;
      }
      if (req.method !== "POST") return send(res, 405, "", cors), true;
      let body = {};
      try {
        body = JSON.parse((await readBody(req, 4096)) || "{}");
      } catch {}
      const action = pathname.slice("/__kite/account/".length);
      if (action === "signout") {
        sessions.signOut(req, res);
        return json(200, { user: null }), true;
      }
      if (action === "signout-everywhere") {
        const user = sessions.userOf(req);
        if (user) sessions.signOutEverywhere(user);
        sessions.signOut(req, res);
        return json(200, { user: null }), true;
      }
      if (action === "google") {
        const r = takeGoogleResult(body.claim);
        if (!r) return json(202, { waiting: true }), true;
        if (r.error) return json(400, { error: r.error }), true;
        const error = sessions.signInWithGoogle(req, res, r.ok, { allowNew: SIGNUP_ON });
        if (error) return json(403, { error }), true;
        return json(200, { user: sessions.displayName(sessions.userOf(req)) || r.ok.email }), true;
      }
      const username = String(body.username || "").trim().toLowerCase();
      if (action === "signup") {
        if (!SIGNUP_ON) return json(403, { error: "Creating accounts is turned off on this Kite." }), true;
        if (!signupAllowed(clientIp)) return json(429, { error: "Too many new accounts from your address. Try again later." }), true;
        const error = await sessions.signUp(req, res, username, body.password);
        if (error) return json(400, { error }), true;
        signups.get(clientIp).push(Date.now());
        console.log(`[info] new Kite account: ${username}`);
        return json(200, { user: username }), true;
      }
      if (action === "signin") {
        const wait = Math.max(lockedFor("ip:" + clientIp), lockedFor("user:" + username));
        if (wait) return json(429, { error: `Too many wrong passwords. Try again in ${wait} seconds.` }), true;
        if (await sessions.signIn(req, res, username, body.password)) {
          failures.delete("ip:" + clientIp);
          failures.delete("user:" + username);
          return json(200, { user: username }), true;
        }
        failed("ip:" + clientIp);
        failed("user:" + username);
        return json(401, { error: "Wrong username or password." }), true;
      }
      return send(res, 404, "", cors), true;
    }
    const jar = sessions.jarFor(req, res);
    if (pathname === "/__kite/ticket") {
      return send(res, 200, JSON.stringify({ ticket: sessions.issueTicket() }), { ...cors, "content-type": "application/json" }), true;
    }
    if (pathname === "/__kite/cookies/import") {
      if (req.method !== "POST") return send(res, 405, "", cors), true;
      const body = await readBody(req, 2 * 1024 * 1024);
      let list;
      try {
        list = parseCookieExport(body);
      } catch (err) {
        return send(res, 400, JSON.stringify({ error: err.message }), { ...cors, "content-type": "application/json" }), true;
      }
      const imported = jar.import(list.slice(0, 5000));
      sessions.changed();
      console.log(`[info] imported ${imported} of ${list.length} cookies`);
      return send(res, 200, JSON.stringify({ imported, found: list.length, user: sessions.userOf(req), sites: jar.summary() }),
        { ...cors, "content-type": "application/json" }), true;
    }
    if (pathname === "/__kite/cookies/clear") {
      if (req.method !== "POST") return send(res, 405, "", cors), true;
      const site = new URLSearchParams((await readBody(req, 1024)) || "").get("site");
      jar.clear(site ? siteOf(site) : undefined); // "www.youtube.com" clears youtube.com's cookies
      sessions.changed();
    }
    return send(res, 200, JSON.stringify({ sites: jar.summary() }), { ...cors, "content-type": "application/json" }), true;
  }

  return send(res, 404), true;
}
