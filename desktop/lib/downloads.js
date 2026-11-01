// Downloads, like Chrome's: files go straight to your Downloads folder (named
// "file (1).zip" if one exists), with progress, pause, resume, cancel, open and
// show in folder. Nothing is ever opened without you clicking it.
const path = require("node:path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");

function uniquePath(dir, filename) {
  const safe = String(filename || "download").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "download";
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate) || fs.existsSync(candidate + ".crdownload"); n++) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

class Downloads extends EventEmitter {
  constructor({ dir, shell }) {
    super();
    this.dir = dir;
    this.shell = shell;
    this.items = new Map(); // id -> { item, info }
    this.nextId = 1;
  }

  // Watch a profile's session for downloads.
  attach(ses, profileId) {
    ses.on("will-download", (_event, item) => {
      const id = this.nextId++;
      const savePath = uniquePath(this.dir(), item.getFilename());
      item.setSavePath(savePath);
      const info = {
        id,
        profileId,
        filename: path.basename(savePath),
        path: savePath,
        url: item.getURL(),
        received: 0,
        total: item.getTotalBytes(),
        state: "progressing",
        paused: false,
        startedAt: Date.now(),
      };
      this.items.set(id, { item, info });
      this.#trim(profileId);
      const update = () => {
        info.received = item.getReceivedBytes();
        info.total = item.getTotalBytes();
        info.paused = item.isPaused();
        this.emit("changed", profileId);
      };
      item.on("updated", (_e, state) => {
        info.state = state; // progressing | interrupted
        update();
      });
      item.once("done", (_e, state) => {
        info.state = state; // completed | cancelled | interrupted
        update();
        this.emit("done", profileId, { ...info });
      });
      this.emit("changed", profileId);
      this.emit("started", profileId, { ...info });
    });
  }

  list(profileId) {
    return [...this.items.values()].filter((d) => d.info.profileId === profileId).map((d) => ({ ...d.info })).reverse();
  }

  action(profileId, id, cmd) {
    const d = this.items.get(Number(id));
    if (!d || d.info.profileId !== profileId) return false;
    const { item, info } = d;
    if (cmd === "pause" && info.state === "progressing") item.pause();
    else if (cmd === "resume" && item.canResume()) item.resume();
    else if (cmd === "cancel" && info.state === "progressing") item.cancel();
    else if (cmd === "open" && info.state === "completed") this.shell.openPath(info.path);
    else if (cmd === "show") this.shell.showItemInFolder(info.path);
    else if (cmd === "remove") {
      if (info.state === "progressing") item.cancel();
      this.items.delete(info.id);
    } else return false;
    info.paused = item.isPaused();
    this.emit("changed", profileId);
    return true;
  }

  #trim(profileId) {
    const mine = [...this.items.values()].filter((d) => d.info.profileId === profileId && d.info.state !== "progressing");
    while (mine.length > 50) this.items.delete(mine.shift().info.id);
  }
}

module.exports = { Downloads, uniquePath };
