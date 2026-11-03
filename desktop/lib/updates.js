// Updating the installed Kite app from GitHub Releases (electron-updater).
// At start and every 4 hours the app looks for a newer release, downloads it
// in the background, then asks: "Restart now" or "Later" (it's then installed
// the next time Kite closes). Only in the installed app, not when run with
// start_desktop.bat. Menu: "Check for updates…".

const EVERY_MS = 4 * 60 * 60 * 1000;

class Updates {
  // app, dialog: Electron's. window(): the window to ask in. log(level, text): Kite DevTools.
  // load(): electron-updater's autoUpdater (tests pass their own).
  constructor({ app, dialog, window = () => null, log = () => {}, load = () => require("electron-updater").autoUpdater }) {
    Object.assign(this, { app, dialog, window, log, load });
    this.state = "idle"; // idle | dev | checking | downloading | ready | latest | error
    this.version = null;
    this.error = null;
    this.updater = null;
    this.asked = null;
    this.manual = false;
  }

  start() {
    if (!this.app.isPackaged) {
      this.state = "dev";
      return false;
    }
    try {
      this.updater = this.load();
    } catch (err) {
      this.state = "error";
      this.error = `Updates aren't available: ${err.message}`;
      return false;
    }
    const u = this.updater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.on("checking-for-update", () => (this.state = "checking"));
    u.on("update-available", (info) => {
      this.state = "downloading";
      this.version = info && info.version;
      this.log("log", `[update] Kite ${this.version} found, downloading`);
    });
    u.on("update-not-available", () => {
      this.state = "latest";
      if (this.manual) this.#tell("You have the latest version of Kite", `Kite ${this.app.getVersion()} is the newest version.`);
      this.manual = false;
    });
    u.on("update-downloaded", (info) => {
      this.state = "ready";
      this.version = info && info.version;
      this.log("log", `[update] Kite ${this.version} downloaded, ready to install`);
      this.ask();
    });
    u.on("error", (err) => {
      this.state = "error";
      this.error = String((err && err.message) || err).slice(0, 300);
      this.log("warn", `[update] couldn't update: ${this.error}`);
      if (this.manual) this.#tell("Couldn't check for updates", this.error);
      this.manual = false;
    });
    this.check();
    const t = setInterval(() => this.check(), EVERY_MS);
    if (t.unref) t.unref();
    return true;
  }

  check(manual = false) {
    if (!this.updater) {
      if (manual) this.#tell("Updates", this.state === "dev" ? "Kite updates itself when installed with Kite Setup. This copy runs from its source folder: use git pull." : this.error || "Updates aren't available.");
      return;
    }
    if (this.state === "ready") return manual ? this.ask(true) : undefined;
    this.manual = manual;
    Promise.resolve(this.updater.checkForUpdates()).catch(() => {});
  }

  // A new version is downloaded: restart now, or install it when Kite closes.
  async ask(again = false) {
    if (this.asked === this.version && !again) return;
    this.asked = this.version;
    const win = this.window();
    const opts = {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Kite update",
      message: `Kite ${this.version} is ready`,
      detail: "Restart Kite to start using it. Your tabs come back if “Continue where you left off” is on in Settings. If you choose Later, it's installed the next time you close Kite.",
    };
    const { response } = await (win ? this.dialog.showMessageBox(win, opts) : this.dialog.showMessageBox(opts));
    if (response === 0) this.updater.quitAndInstall();
  }

  #tell(message, detail) {
    const win = this.window();
    const opts = { type: "info", buttons: ["OK"], title: "Kite", message, detail };
    return win ? this.dialog.showMessageBox(win, opts) : this.dialog.showMessageBox(opts);
  }

  status() {
    return { state: this.state, version: this.version, error: this.error, current: this.app.getVersion ? this.app.getVersion() : null };
  }
}

module.exports = { Updates };
