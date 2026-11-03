// The installed app updating itself (lib/updates.js), with a stand-in updater.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const { Updates } = require("../lib/updates.js");

function setup({ packaged = true, answer = 0 } = {}) {
  const updater = Object.assign(new EventEmitter(), { checks: 0, installed: 0, checkForUpdates() { this.checks++; return Promise.resolve(); }, quitAndInstall() { this.installed++; } });
  const asked = [];
  const logs = [];
  const u = new Updates({
    app: { isPackaged: packaged, getVersion: () => "1.0.0" },
    dialog: { showMessageBox: async (...a) => (asked.push(a[a.length - 1]), { response: answer }) },
    log: (level, text) => logs.push(`${level} ${text}`),
    load: () => updater,
  });
  return { u, updater, asked, logs };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("run from source (start_desktop.bat): no updating, git pull instead", async () => {
  const { u, updater, asked } = setup({ packaged: false });
  assert.equal(u.start(), false);
  assert.equal(u.status().state, "dev");
  assert.equal(updater.checks, 0);
  u.check(true);
  await tick();
  assert.match(asked[0].detail, /git pull/);
});

test("installed: checks at start, downloads, asks once, restarts on yes", async () => {
  const { u, updater, asked, logs } = setup();
  assert.equal(u.start(), true);
  assert.equal(updater.checks, 1);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  updater.emit("update-available", { version: "1.0.1" });
  assert.equal(u.status().state, "downloading");
  updater.emit("update-downloaded", { version: "1.0.1" });
  await tick();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "Kite 1.0.1 is ready");
  assert.deepEqual(asked[0].buttons, ["Restart now", "Later"]);
  assert.equal(updater.installed, 1);
  updater.emit("update-downloaded", { version: "1.0.1" });
  await tick();
  assert.equal(asked.length, 1, "not asked twice for the same version");
  assert.ok(logs.some((l) => l.includes("Kite 1.0.1 downloaded")));
});

test("Later: installed when Kite closes; Check for updates asks again", async () => {
  const { u, updater, asked } = setup({ answer: 1 });
  u.start();
  updater.emit("update-downloaded", { version: "1.1.0" });
  await tick();
  assert.equal(updater.installed, 0);
  u.check(true);
  await tick();
  assert.equal(asked.length, 2);
});

test("Check for updates when up to date, and when it fails", async () => {
  const { u, updater, asked, logs } = setup();
  u.start();
  u.check(true);
  updater.emit("update-not-available", {});
  await tick();
  assert.equal(asked[0].message, "You have the latest version of Kite");
  updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
  await tick();
  assert.equal(asked.length, 1, "a background failure doesn't interrupt you");
  assert.equal(u.status().state, "error");
  assert.ok(logs.some((l) => l.startsWith("warn [update]")));
});
