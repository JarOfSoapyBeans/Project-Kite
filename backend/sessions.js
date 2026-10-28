// Kite sessions (Stage 4). Each person using Kite gets a private random session
// id in a "kite_sid" cookie on the backend's own address; it selects their cookie
// jar. Websites never see it, and one person's site cookies never mix with another's.
//
// Jars live in memory. Set COOKIE_FILE=/path/to/cookies.json to keep them (and so
// your logins) across backend restarts; the file holds your site logins, so keep
// it private (it is written with owner-only permissions).

import crypto from "node:crypto";
import fs from "node:fs";
import { CookieJar } from "./cookies.js";

export const SESSION_COOKIE = "kite_sid";
const IDLE_MS = 30 * 24 * 3600 * 1000; // forget sessions unused for 30 days
const MAX_SESSIONS = 1000;

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
    this.map = new Map(); // id -> { jar, lastUsed }
    this.saveTimer = null;
    if (file) this.#load();
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
      id = crypto.randomBytes(24).toString("base64url");
      s = { jar: new CookieJar(), lastUsed: Date.now() };
      this.map.set(id, s);
      this.#evict();
      res.setHeader(
        "set-cookie",
        `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${IDLE_MS / 1000}; HttpOnly; ${cookieAttributes(req)}`
      );
    }
    s.lastUsed = Date.now();
    return s.jar;
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
    const data = { sessions: {} };
    for (const [id, s] of this.map) data.sessions[id] = { lastUsed: s.lastUsed, cookies: s.jar.toJSON() };
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
      for (const [id, s] of Object.entries(data.sessions || {})) {
        if (now - s.lastUsed < IDLE_MS) this.map.set(id, { jar: CookieJar.fromJSON(s.cookies), lastUsed: s.lastUsed });
      }
      console.log(`[info] loaded ${this.map.size} Kite session(s) from ${this.file}`);
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
