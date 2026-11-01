// Kite sessions (Stage 4). Each person using Kite gets a private random session
// id in a "kite_sid" cookie on the backend's own address; it selects their cookie
// jar. Websites never see it, and one person's site cookies never mix with another's.
//
// Kite accounts: someone who signs in to Kite gets their account's jar instead
// of the session's own, on every device they sign in from. Passwords are kept
// only as scrypt hashes (random salt each), never as the password itself.
//
// Jars live in memory. Set COOKIE_FILE=/path/to/cookies.json to keep them (and so
// your logins) across backend restarts; the file holds your site logins, so keep
// it private (it is written with owner-only permissions).

import crypto from "node:crypto";
import fs from "node:fs";
import { CookieJar } from "./cookies.js";

export const SESSION_COOKIE = "kite_sid";
const IDLE_MS = 30 * 24 * 3600 * 1000; // forget sessions unused for 30 days
const TICKET_MS = 6 * 3600 * 1000; // tab tickets work for 6 hours
const MAX_TICKETS = 10000;
const MAX_SESSIONS = 1000;
const MAX_ACCOUNTS = 200;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password).normalize("NFKC"), salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)))
  );
}
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function readSessionId(req) {
  const m = /(?:^|;\s*)kite_sid=([A-Za-z0-9_-]{16,64})(?:;|$)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}

// Browsers only send cookies to an iframe on another site (the Kite UI embeds the
// backend) if they are SameSite=None + Secure; "Partitioned" keeps them separate
// per Kite frontend. Plain http only works on the same site (or localhost).
function cookieAttributes(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().replace(/:\d+$/, "");
  const https = req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  return https || local ? "Secure; SameSite=None; Partitioned" : "SameSite=Lax";
}

export class Sessions {
  constructor({ file = null } = {}) {
    this.file = file;
    this.map = new Map(); // id -> { jar, lastUsed, user? }
    this.accounts = new Map(); // username -> { salt, hash, jar, created }
    this.tickets = new Map(); // ticket -> expiry time
    this.saveTimer = null;
    if (file) this.#load();
  }

  // Tab tickets: the Kite UI asks for one (a request browsers always label with
  // the UI's origin) and attaches it to a tab's first load, so that load is let in
  // even when the browser sends neither a Referer nor the session cookie.
  issueTicket() {
    const now = Date.now();
    for (const [t, exp] of this.tickets) if (exp <= now) this.tickets.delete(t);
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value);
    const ticket = crypto.randomBytes(24).toString("base64url");
    this.tickets.set(ticket, now + TICKET_MS);
    return ticket;
  }

  checkTicket(ticket) {
    const exp = ticket && this.tickets.get(ticket);
    return Boolean(exp && exp > Date.now());
  }

  // True if the request carries a valid Kite session. Sessions are only created for
  // requests that passed the backend's checks, and browsers keep this cookie
  // separate per top-level site (Partitioned), so another site can't borrow it.
  has(req) {
    const id = readSessionId(req);
    return Boolean(id && this.map.has(id));
  }

  // The jar for this request's session. Creates a session (and sets its cookie on
  // `res`) when there is none and `res` is given.
  jarFor(req, res = null) {
    let id = readSessionId(req);
    let s = id && this.map.get(id);
    if (!s) {
      if (!res) return null;
      s = this.#newSession(req, res);
    }
    s.lastUsed = Date.now();
    const account = s.user && this.accounts.get(s.user);
    return account ? account.jar : s.jar;
  }

  #newSession(req, res, user = null) {
    const id = crypto.randomBytes(24).toString("base64url");
    const s = { jar: new CookieJar(), lastUsed: Date.now() };
    if (user) s.user = user;
    this.map.set(id, s);
    this.#evict();
    res.setHeader("set-cookie", `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${IDLE_MS / 1000}; HttpOnly; ${cookieAttributes(req)}`);
    return s;
  }

  // ---------- accounts ----------

  // The signed-in username for this request, or null (a guest).
  userOf(req) {
    const s = this.map.get(readSessionId(req));
    return s && s.user && this.accounts.has(s.user) ? s.user : null;
  }

  // Returns an error message, or null on success (and signs the request in).
  async signUp(req, res, username, password) {
    username = String(username || "").trim().toLowerCase();
    if (!USERNAME.test(username)) return "Usernames are 3-32 letters, digits, dots, dashes or underscores.";
    if (String(password || "").length < 8) return "Use a password of at least 8 characters.";
    if (String(password).length > 200) return "That password is too long.";
    if (this.accounts.has(username)) return "That username is taken.";
    if (this.accounts.size >= MAX_ACCOUNTS) return "This Kite has reached its account limit.";
    const salt = crypto.randomBytes(16);
    const hash = await hashPassword(password, salt);
    if (this.accounts.has(username)) return "That username is taken.";
    this.accounts.set(username, { salt: salt.toString("base64"), hash: hash.toString("base64"), jar: new CookieJar(), created: Date.now() });
    this.#startSignedIn(req, res, username);
    return null;
  }

  // True if the username and password match (and signs the request in).
  async signIn(req, res, username, password) {
    username = String(username || "").trim().toLowerCase();
    const account = this.accounts.get(username);
    // Unknown usernames take as long as wrong passwords, so they can't be told apart.
    const salt = account ? Buffer.from(account.salt, "base64") : crypto.randomBytes(16);
    const hash = await hashPassword(String(password || "").slice(0, 200), salt);
    if (!account || !crypto.timingSafeEqual(hash, Buffer.from(account.hash, "base64"))) return false;
    this.#startSignedIn(req, res, username);
    return true;
  }

  // A fresh session id on every sign-in (so an id someone saw earlier is useless).
  #startSignedIn(req, res, username) {
    this.map.delete(readSessionId(req));
    this.#newSession(req, res, username);
    this.changed();
  }

  // Back to being a guest (a new, empty guest session).
  signOut(req, res) {
    this.map.delete(readSessionId(req));
    this.#newSession(req, res);
    this.changed();
  }

  // Signs the account out on every device. Returns how many sessions ended.
  signOutEverywhere(username) {
    let n = 0;
    for (const [id, s] of this.map) if (s.user === username) this.map.delete(id), n++;
    this.changed();
    return n;
  }

  // Call after a jar changes so it can be saved.
  changed() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref();
  }

  save() {
    if (!this.file) return;
    const data = { sessions: {}, accounts: {} };
    for (const [id, s] of this.map) {
      data.sessions[id] = s.user ? { lastUsed: s.lastUsed, user: s.user } : { lastUsed: s.lastUsed, cookies: s.jar.toJSON() };
    }
    for (const [name, a] of this.accounts) {
      data.accounts[name] = { salt: a.salt, hash: a.hash, created: a.created, cookies: a.jar.toJSON() };
    }
    const tmp = this.file + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[warn] could not save cookies to ${this.file}: ${err.message}`);
    }
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const now = Date.now();
      for (const [name, a] of Object.entries(data.accounts || {})) {
        if (USERNAME.test(name) && a.salt && a.hash) {
          this.accounts.set(name, { salt: a.salt, hash: a.hash, created: a.created, jar: CookieJar.fromJSON(a.cookies) });
        }
      }
      for (const [id, s] of Object.entries(data.sessions || {})) {
        if (now - s.lastUsed >= IDLE_MS) continue;
        const entry = { jar: CookieJar.fromJSON(s.cookies), lastUsed: s.lastUsed };
        if (s.user && this.accounts.has(s.user)) entry.user = s.user;
        this.map.set(id, entry);
      }
      console.log(`[info] loaded ${this.map.size} Kite session(s) and ${this.accounts.size} account(s) from ${this.file}`);
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[warn] could not read ${this.file}: ${err.message}`);
    }
  }

  #evict() {
    const now = Date.now();
    for (const [id, s] of this.map) if (now - s.lastUsed > IDLE_MS) this.map.delete(id);
    if (this.map.size <= MAX_SESSIONS) return;
    const oldest = [...this.map].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.map.size > MAX_SESSIONS) this.map.delete(oldest.shift()[0]);
  }
}
