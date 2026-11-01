// Kite account data (Stage 7 part 5): the history, bookmarks, new tab shortcuts
// and settings of a Kite account, so Kite Web follows you between devices and
// the Kite app can sync with it. No dependencies.
//
// Each kind is stored as { value, updated } (updated: a version number, the time
// it was last written). A device sends what it has with `base`: the version it
// last saw. If nobody wrote since then, its value simply replaces the stored
// one (so deleting works). If someone did, the two are merged where that makes
// sense (history and bookmarks: both devices' additions are kept), otherwise
// the newest write wins.

import crypto from "node:crypto";

export const ACCOUNT_DATA = new Set(["history", "bookmarks", "shortcuts", "settings"]);
const MAX_ONE = 4 * 1024 * 1024; // bytes of JSON per kind
const MAX_HISTORY = 5000;

function mergeHistory(stored, incoming) {
  const seen = new Set();
  const all = [];
  for (const v of [...(incoming || []), ...(stored || [])]) {
    if (!v || typeof v.url !== "string") continue;
    const key = v.url + "\n" + v.time;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(v);
  }
  return all.sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, MAX_HISTORY);
}

function mergeByUrl(stored, incoming) {
  const out = [...(incoming || [])];
  const have = new Set(out.map((b) => b && b.url));
  for (const b of stored || []) if (b && !have.has(b.url)) out.push(b);
  return out;
}

export function mergeData(name, stored, incoming) {
  if (name === "history") return mergeHistory(stored, incoming);
  if (name === "bookmarks" || name === "shortcuts") return mergeByUrl(stored, incoming);
  return incoming; // settings: the newest wins
}

// Store `value` for `name` in account.data. Returns { updated, value, merged }
// or { error }.
export function putData(account, name, value, base) {
  if (!ACCOUNT_DATA.has(name)) return { error: "unknown data" };
  const text = JSON.stringify(value ?? null);
  if (text.length > MAX_ONE) return { error: "too big" };
  value = JSON.parse(text);
  const data = (account.data ||= {});
  const now = data[name];
  let merged = false;
  if (now && Number(base) !== now.updated && Array.isArray(now.value) && Array.isArray(value)) {
    value = mergeData(name, now.value, value);
    merged = true;
  }
  const updated = Math.max(Date.now(), (now ? now.updated : 0) + 1); // always moves forward
  data[name] = { value, updated };
  return { updated, value, merged };
}

// Just the version of each kind: cheap to ask for often ("has anything changed?").
export function getVersions(account) {
  const out = {};
  for (const name of ACCOUNT_DATA) if (account.data && account.data[name]) out[name] = account.data[name].updated;
  return out;
}

export function getData(account) {
  const out = {};
  for (const name of ACCOUNT_DATA) if (account.data && account.data[name]) out[name] = account.data[name];
  return out;
}

// ---------- linking the Kite app to an account ----------
// The Kite UI (signed in) asks for a short one-time code; you type it into the
// app, which trades it for a long-lived sync token. Only a hash of each token is
// stored, so the saved file can't be used to sync.

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const CODE_MS = 10 * 60 * 1000;
const codes = new Map(); // code -> { user, expires }

export function newLinkCode(user) {
  const now = Date.now();
  for (const [c, v] of codes) if (v.expires <= now) codes.delete(c);
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) code += CODE_CHARS[b % CODE_CHARS.length];
  code = code.slice(0, 4) + "-" + code.slice(4);
  codes.set(code, { user, expires: now + CODE_MS });
  return { code, expires: now + CODE_MS };
}

// Returns the user the code was for (once), or null.
export function useLinkCode(code) {
  code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  code = code.slice(0, 4) + "-" + code.slice(4);
  const v = codes.get(code);
  codes.delete(code);
  return v && v.expires > Date.now() ? v.user : null;
}

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("base64url");

export function newToken(account, device) {
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomBytes(6).toString("hex");
  (account.tokens ||= []).push({ id, hash: hashToken(token), device: String(device || "Kite app").slice(0, 60), created: Date.now(), lastUsed: 0 });
  if (account.tokens.length > 20) account.tokens.shift();
  return token;
}

export function devices(account) {
  return (account.tokens || []).map(({ id, device, created, lastUsed }) => ({ id, device, created, lastUsed }));
}

export function unlink(account, id) {
  const before = (account.tokens || []).length;
  account.tokens = id === "all" ? [] : (account.tokens || []).filter((t) => t.id !== id);
  return account.tokens.length < before;
}

export function resetLinkCodes() {
  codes.clear();
}
