// Where Kite Web keeps history, bookmarks, new tab shortcuts and settings:
//   signed in to a Kite account   on the backend, in your account, so they
//                                 follow you to every device (and the Kite app
//                                 if you link it)
//   a guest                       in this browser (localStorage)
// Your open tabs ("session") always stay in this browser.

const ACCOUNT = new Set(["history", "bookmarks", "shortcuts", "settings"]);
const local = {
  get(name) {
    try {
      return JSON.parse(localStorage.getItem("kite:" + name) || "null");
    } catch {
      return null;
    }
  },
  set(name, value) {
    try {
      localStorage.setItem("kite:" + name, JSON.stringify(value));
    } catch {} // full or blocked: keep going without saving
  },
};

export function createWebData(backend) {
  let user; // undefined: not checked yet; null: guest; "name": signed in
  let remote = null; // promise of { name: { value, updated } }
  const versions = {}; // name -> the account version we last saw
  let listener = null;
  let pollTimer = null;

  const api = (path, opts = {}) =>
    fetch(backend() + path, {
      credentials: "include",
      ...opts,
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      signal: AbortSignal.timeout(10000),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

  async function who() {
    if (user === undefined) {
      try {
        user = (await api("/__kite/account")).user || null;
      } catch {
        user = null; // backend unreachable: work from this browser
      }
    }
    return user;
  }

  function fetchRemote() {
    remote = api("/__kite/data").catch(() => ({}));
    return remote;
  }

  // Other devices' changes: look every minute while signed in.
  function poll() {
    clearInterval(pollTimer);
    if (!user) return;
    pollTimer = setInterval(async () => {
      const all = await fetchRemote();
      for (const [name, v] of Object.entries(all)) {
        if (v.updated > (versions[name] || 0)) {
          versions[name] = v.updated;
          if (listener) listener(name, v.value);
        }
      }
    }, 60_000);
  }

  return {
    async load(name) {
      if (!ACCOUNT.has(name) || !(await who())) return local.get(name);
      const all = await (remote || fetchRemote());
      poll();
      const v = all[name];
      if (v) {
        versions[name] = v.updated;
        return v.value;
      }
      // First time with this account on this browser: bring what's here along.
      const here = local.get(name);
      if (here !== null) this.save(name, here);
      return here;
    },

    async save(name, value) {
      if (!ACCOUNT.has(name) || !user) return local.set(name, value);
      try {
        const r = await api("/__kite/data/" + name, { method: "PUT", body: JSON.stringify({ value, base: versions[name] || 0 }) });
        versions[name] = r.updated;
        // Another device changed it meanwhile: the merged result comes back.
        if ("value" in r && listener) listener(name, r.value);
      } catch {}
    },

    onChange(fn) {
      listener = fn;
      // Other Kite Web tabs in this browser (guest data).
      window.addEventListener("storage", (e) => {
        if (user || !e.key || !e.key.startsWith("kite:")) return;
        try {
          fn(e.key.slice(5), JSON.parse(e.newValue || "null"));
        } catch {}
      });
    },

    // Signed in or out: everything comes from the new place.
    async accountChanged(next) {
      if ((next || null) === user) return;
      user = next || null;
      remote = null;
      for (const k of Object.keys(versions)) delete versions[k];
      for (const name of ACCOUNT) {
        const value = await this.load(name);
        if (listener) listener(name, value);
      }
      poll();
    },
  };
}
