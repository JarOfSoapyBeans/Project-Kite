// The app's building blocks: profiles, site permissions, downloads, menus.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Profiles } = require("../lib/profiles.js");
const { SitePermissions, attachPermissions } = require("../lib/permissions.js");
const { Downloads, uniquePath } = require("../lib/downloads.js");
const { pageMenu, tabMenu, appMenu } = require("../lib/menus.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kite-app-"));

test("profiles: main always exists; add, rename, remove; kept on disk; guests aren't", () => {
  const dir = tmp();
  const p = new Profiles(dir);
  assert.deepEqual(p.list(), [{ id: "main", name: "Main" }]);
  const work = p.add("Work");
  assert.ok(p.rename(work.id, "School"));
  assert.equal(p.partitionFor("main"), "persist:main");
  assert.equal(p.partitionFor(work.id), "persist:profile-" + work.id);
  assert.equal(p.remove("main"), false);
  p.store.saveNow();
  assert.deepEqual(new Profiles(dir).list().map((x) => x.name), ["Main", "School"]);
  assert.ok(p.remove(work.id));
  const g = p.guest();
  assert.ok(g.guest && !p.get(g.id));
});

function fakeSession() {
  const s = new EventEmitter();
  s.setPermissionRequestHandler = (fn) => (s.request = fn);
  s.setPermissionCheckHandler = (fn) => (s.check = fn);
  return s;
}
const ask = (ses, permission, details) => new Promise((r) => ses.request({ getURL: () => "https://meet.example/x" }, permission, r, details));

test("permissions: asks, remembers per site, separately for camera and microphone", async () => {
  const perms = new SitePermissions(tmp(), "main");
  const ses = fakeSession();
  const asked = [];
  let answer = { allow: true, remember: true };
  attachPermissions(ses, perms, (req) => (asked.push(req), answer));
  assert.equal(await ask(ses, "fullscreen", {}), true, "never asked");
  assert.equal(await ask(ses, "usb", {}), false, "not something Kite allows");
  assert.equal(await ask(ses, "media", { mediaTypes: ["video"], requestingUrl: "https://meet.example/room" }), true);
  assert.equal(asked[0].text, "use your camera");
  assert.equal(asked[0].origin, "https://meet.example");
  assert.equal(await ask(ses, "media", { mediaTypes: ["video"], requestingUrl: "https://meet.example/other" }), true);
  assert.equal(asked.length, 1, "remembered for the site");
  answer = { allow: false, remember: false };
  assert.equal(await ask(ses, "media", { mediaTypes: ["video", "audio"], requestingUrl: "https://meet.example/" }), false);
  assert.equal(asked[1].text, "use your camera and microphone", "microphone not decided yet, so asked again");
  assert.equal(ses.check(null, "media", "https://meet.example", { mediaType: "video" }), true);
  assert.equal(ses.check(null, "media", "https://meet.example", { mediaType: "audio" }), false);
  assert.deepEqual(perms.forSite("https://meet.example"), { camera: "allow" });
  perms.reset("https://meet.example");
  assert.deepEqual(perms.forSite("https://meet.example"), {});
  assert.equal(await ask(ses, "geolocation", { requestingUrl: "file:///x" }), false, "only websites can ask");
});

function fakeItem(name, total = 100) {
  const i = new EventEmitter();
  Object.assign(i, {
    received: 0, paused: false, savePath: null,
    getFilename: () => name, getURL: () => "https://files.example/" + name, getTotalBytes: () => total,
    getReceivedBytes: () => i.received, isPaused: () => i.paused, canResume: () => true,
    setSavePath: (p) => (i.savePath = p), pause: () => (i.paused = true), resume: () => (i.paused = false), cancel: () => i.emit("done", {}, "cancelled"),
  });
  return i;
}

test("downloads: to the Downloads folder with a free name, progress, actions, per profile", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "report.pdf"), "old");
  const opened = [];
  const d = new Downloads({ dir: () => dir, shell: { openPath: (p) => opened.push(["open", p]), showItemInFolder: (p) => opened.push(["show", p]) } });
  const ses = new EventEmitter();
  d.attach(ses, "main");
  let changes = 0;
  d.on("changed", () => changes++);
  const item = fakeItem("report.pdf");
  ses.emit("will-download", {}, item);
  assert.equal(item.savePath, path.join(dir, "report (1).pdf"));
  item.received = 40;
  item.emit("updated", {}, "progressing");
  let [info] = d.list("main");
  assert.equal(info.received, 40);
  assert.equal(info.filename, "report (1).pdf");
  assert.ok(d.action("main", info.id, "pause"));
  assert.equal(d.list("main")[0].paused, true);
  assert.equal(d.action("other", info.id, "cancel"), false, "another profile can't touch it");
  assert.equal(d.action("main", info.id, "open"), false, "not finished: can't open");
  item.received = 100;
  item.emit("done", {}, "completed");
  assert.ok(d.action("main", info.id, "open"));
  assert.deepEqual(opened, [["open", path.join(dir, "report (1).pdf")]]);
  assert.deepEqual(d.list("other"), []);
  assert.ok(changes >= 4);
  assert.equal(path.basename(uniquePath(dir, "../../evil.exe")), ".._.._evil.exe".replace(/^\.+/, "_"));
});

test("page menu: links, images, text, editable fields, the page", () => {
  const labels = (params) => pageMenu({ x: 1, y: 2, pageURL: "https://a.test/", ...params }, { canGoBack: true, searchName: "Bing" }, () => {}).map((i) => i.label || "-");
  assert.deepEqual(labels({ linkURL: "https://b.test/" }).slice(0, 4), ["Open link in new tab", "Open link in new window", "Save link as…", "Copy link address"]);
  assert.ok(labels({ mediaType: "image", srcURL: "https://a.test/i.png" }).includes("Copy image"));
  assert.ok(labels({ selectionText: "paper kites" }).includes("Search Bing for “paper kites”"));
  const edit = labels({ isEditable: true, misspelledWord: "kiet", dictionarySuggestions: ["kite", "kit"], editFlags: { canPaste: true } });
  assert.deepEqual(edit.slice(0, 3), ["kite", "kit", "Add to dictionary"]);
  assert.ok(edit.includes("Paste"));
  const page = labels({});
  assert.ok(page.includes("Back") && page.includes("Print…") && page.includes("View page source") && page.at(-1) === "Inspect");
  const acted = [];
  pageMenu({ linkURL: "https://b.test/" }, {}, (a, v) => acted.push([a, v]))[0].click();
  assert.deepEqual(acted, [["open-tab", "https://b.test/"]]);
  assert.ok(!labels({ linkURL: "javascript:evil()" }).includes("Open link in new tab"), "only web links");
});

test("tab and app menus", () => {
  const chosen = [];
  const t = tabMenu({ canReopen: false, count: 1 }, (a) => chosen.push(a));
  assert.equal(t.find((i) => i.label === "Close other tabs").enabled, false);
  t.find((i) => i.label === "Duplicate").click();
  const a = appMenu({ profiles: [{ id: "main", name: "Main" }, { id: "p1", name: "Work" }], currentProfile: "main" }, (x) => chosen.push(x));
  a.find((i) => i.label === "Profiles").submenu[1].click();
  a.find((i) => i.label === "New guest window").click();
  assert.deepEqual(chosen, ["duplicate", "open-profile:p1", "guest-window"]);
});
