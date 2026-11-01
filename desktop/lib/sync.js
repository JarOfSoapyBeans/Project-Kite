// Syncing a profile's history, bookmarks, new tab shortcuts and settings with a
// Kite account on your Kite backend (the same data Kite Web shows when you're
// signed in). You link a profile once with a one-time code from Kite Web
// (account panel -> "Link the Kite app"); the app keeps the token it gets.
//
// When: at start, every 2 minutes, and a few seconds after you change something.
// How: for each kind of data, if only the account changed, the app takes it; if
// only the app did, it sends it; if both did, the backend merges them (history
// and bookmarks keep both sides' additions; settings: the newest wins).
const path = require("node:path");
const os = require("node:os");
const { JsonStore } = require("./store.js");

const NAMES = ["history", "bookmarks", "shortcuts", "settings"];
const EVERY_MS = 2 * 60 * 1000;
const AFTER_CHANGE_MS = 5000;
const AFTER_HISTORY_MS = 30_000; // history changes with every page: send it less often

class Sync {
  // read(profileId, name) / write(profileId, name, value): the profile's local data.
  // changed(profileId, name, value): tell the profile's windows.
  // synced(profileId, { sent, took, error }): after each sync (for Kite DevTools).
  constructor({ dir, read, write, changed, synced = () => {}, fetchImpl = fetch, device = `Kite app on ${os.hostname()}` }) {
    Object.assign(this, { dir, read, write, changed, synced, fetchImpl, device });
    this.stores = new Map(); // profile id -> JsonStore of { backend, token, user, versions, dirty, lastSync, error }
    this.timers = new Map();
    this.running = new Map();
  }

  #store(profileId) {
    if (!this.stores.has(profileId)) {
      const file = this.dir ? path.join(this.dir, `sync-${profileId}.json`) : null;
      this.stores.set(profileId, new JsonStore(file, { versions: {}, dirty: {} }));
    }
    return this.stores.get(profileId);
  }

  status(profileId) {
    const c = this.#store(profileId).data;
    return { linked: Boolean(c.token), user: c.user || null, backend: c.backend || null, lastSync: c.lastSync || 0, error: c.error || null };
  }

  async #api(c, method, p, body) {
    const r = await this.fetchImpl(c.backend + p, {
      method,
      headers: { ...(c.token ? { authorization: "Bearer " + c.token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || `Kite answered ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  // Link a profile: trade the one-time code for a token, then sync.
  async link(profileId, backend, code) {
    let base;
    try {
      const u = new URL(String(backend || "").trim());
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      base = u.origin;
    } catch {
      return { error: "Enter your Kite address, like https://kite-api.example.com" };
    }
    const store = this.#store(profileId);
    try {
      const r = await this.#api({ backend: base }, "POST", "/__kite/sync/token", { code, device: this.device });
      // Everything here counts as new, so nothing on either side is lost.
      store.data = { backend: base, token: r.token, user: r.user, versions: {}, dirty: Object.fromEntries(NAMES.map((n) => [n, true])), lastSync: 0, error: null };
      store.saveNow();
    } catch (err) {
      return { error: err.message === "fetch failed" ? "Couldn't reach that Kite address." : err.message };
    }
    await this.syncNow(profileId);
    this.start(profileId);
    return this.status(profileId);
  }

  async unlink(profileId) {
    const store = this.#store(profileId);
    const c = store.data;
    if (c.token) await this.#api(c, "POST", "/__kite/sync/unlink-self", {}).catch(() => {});
    store.data = { versions: {}, dirty: {} };
    store.saveNow();
    clearInterval(this.timers.get(profileId));
    this.timers.delete(profileId);
    return this.status(profileId);
  }

  // The app changed something (main.js saveData): sync soon.
  noteChange(profileId, name) {
    const store = this.#store(profileId);
    if (!store.data.token || !NAMES.includes(name)) return;
    store.data.dirty[name] = true;
    store.changed();
    // A sooner sync already planned stays; history alone waits a little longer.
    const key = "soon:" + profileId;
    const delay = name === "history" ? AFTER_HISTORY_MS : AFTER_CHANGE_MS;
    const planned = this.running.get(key);
    if (planned && planned.at <= Date.now() + delay) return;
    if (planned) clearTimeout(planned.timer);
    const t = setTimeout(() => (this.running.delete(key), this.syncNow(profileId)), delay);
    if (t.unref) t.unref();
    this.running.set(key, { timer: t, at: Date.now() + delay });
  }

  start(profileId) {
    if (!this.#store(profileId).data.token || this.timers.has(profileId)) return;
    const t = setInterval(() => this.syncNow(profileId), EVERY_MS);
    if (t.unref) t.unref();
    this.timers.set(profileId, t);
  }

  syncNow(profileId) {
    // One sync at a time per profile.
    if (this.running.get(profileId)) return this.running.get(profileId);
    const p = this.#sync(profileId).finally(() => this.running.delete(profileId));
    this.running.set(profileId, p);
    return p;
  }

  async #sync(profileId) {
    const store = this.#store(profileId);
    const c = store.data;
    if (!c.token) return this.status(profileId);
    const sent = [];
    const took = [];
    try {
      // First just the versions; only what changed is downloaded.
      const versions = await this.#api(c, "GET", "/__kite/data/versions");
      for (const name of NAMES) {
        const seen = c.versions[name] || 0;
        const local = c.dirty[name] ? this.read(profileId, name) : null;
        // The account's copy is only downloaded when it changed and we'll use it.
        const changed = (versions[name] || 0) > seen;
        const r = changed && local === null ? await this.#api(c, "GET", "/__kite/data/" + name) : null;
        if (local !== null) {
          // We changed it: send it (merged by the backend if the account changed too).
          const put = await this.#api(c, "PUT", "/__kite/data/" + name, { value: local, base: seen });
          c.versions[name] = put.updated;
          if ("value" in put) {
            this.write(profileId, name, put.value);
            this.changed(profileId, name, put.value);
          }
          sent.push(name);
        } else if (r && r.updated > seen) {
          // Only the account changed (or we have nothing yet): take it.
          this.write(profileId, name, r.value);
          this.changed(profileId, name, r.value);
          c.versions[name] = r.updated;
          took.push(name);
        }
        delete c.dirty[name];
      }
      c.lastSync = Date.now();
      c.error = null;
    } catch (err) {
      c.error = err.status === 401 ? "This app was unlinked from your Kite account." : `Couldn't sync: ${err.message}`;
      if (err.status === 401) c.token = null;
    }
    store.changed();
    try {
      this.synced(profileId, { sent, took, error: c.error });
    } catch {}
    return this.status(profileId);
  }
}

module.exports = { Sync, NAMES };
