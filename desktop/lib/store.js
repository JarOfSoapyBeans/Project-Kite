// A small JSON file store: loads once, saves (atomically, a moment later) when
// changed. Used for profiles, site permissions and the like. file = null keeps
// everything in memory (the guest profile).
const fs = require("node:fs");
const path = require("node:path");

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = structuredClone(defaults);
    this.timer = null;
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object") this.data = { ...this.data, ...saved };
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[kite] couldn't read ${file}: ${err.message}`);
    }
  }

  changed() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.saveNow(), 500);
    if (this.timer.unref) this.timer.unref();
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[kite] couldn't save ${this.file}: ${err.message}`);
    }
  }
}

module.exports = { JsonStore };
