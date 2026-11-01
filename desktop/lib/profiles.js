// Profiles: separate sets of cookies, logins, storage and site permissions,
// like Chrome's. "Main" always exists; you can add more. Each window belongs to
// one profile. The guest profile is in memory only: closing its windows forgets it.
const crypto = require("node:crypto");
const path = require("node:path");
const { JsonStore } = require("./store.js");

const MAIN = { id: "main", name: "Main" };

class Profiles {
  constructor(dir) {
    this.dir = dir;
    this.store = new JsonStore(dir ? path.join(dir, "profiles.json") : null, { list: [MAIN] });
    if (!this.store.data.list.some((p) => p.id === "main")) this.store.data.list.unshift(MAIN);
  }

  list() {
    return this.store.data.list.map((p) => ({ id: p.id, name: p.name }));
  }

  get(id) {
    const p = this.store.data.list.find((x) => x.id === id);
    return p ? { id: p.id, name: p.name } : null;
  }

  add(name) {
    name = String(name || "").trim().slice(0, 40) || "Profile";
    const id = "p" + crypto.randomBytes(5).toString("hex");
    this.store.data.list.push({ id, name });
    this.store.changed();
    return { id, name };
  }

  rename(id, name) {
    const p = this.store.data.list.find((x) => x.id === id);
    name = String(name || "").trim().slice(0, 40);
    if (!p || !name) return false;
    p.name = name;
    this.store.changed();
    return true;
  }

  // Main can't be removed. The caller clears the profile's stored data.
  remove(id) {
    if (id === "main") return false;
    const before = this.store.data.list.length;
    this.store.data.list = this.store.data.list.filter((p) => p.id !== id);
    this.store.changed();
    return this.store.data.list.length < before;
  }

  // Where a profile's cookies and storage live (Electron session partitions;
  // "persist:" ones are kept on disk). Main keeps the name it had in part 2.
  partitionFor(id) {
    return id === "main" ? "persist:main" : "persist:profile-" + id;
  }

  // A fresh, in-memory guest profile.
  guest() {
    return { id: "guest-" + crypto.randomBytes(4).toString("hex"), name: "Guest", guest: true };
  }
}

module.exports = { Profiles };
