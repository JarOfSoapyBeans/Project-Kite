// main.js (the Kite app's main process) against a stand-in for Electron.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return path.join(here, "fake-electron.cjs");
  return resolve.call(this, request, ...rest);
};
const fake = require("./fake-electron.cjs");
const S = fake.__state;
let main, win, ui;
const tick = () => new Promise((r) => setTimeout(r, 0));
// Call an IPC handler the way Kite's interface would (or someone else).
const call = (name, args, sender = win.webContents, frame = sender.mainFrame) => S.ipcHandle[name]({ sender, senderFrame: frame }, ...args);
const events = () => ui.sent.filter(([c]) => c === "kite:event").map(([, e]) => e);

before(async () => {
  const index = path.join(here, "..", "app-ui", "index.html");
  if (!fs.existsSync(index)) {
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, "<!doctype html>");
  }
  main = require("../main.js");
  await tick();
  win = S.windows[0];
  ui = win.webContents;
});

test("starts: kite:// scheme, one window with Kite's interface, locked down", () => {
  assert.equal(S.schemes[0].scheme, "kite");
  assert.ok(S.schemes[0].privileges.secure && S.schemes[0].privileges.standard);
  assert.equal(win.webContents.url, "kite://app/index.html");
  const wp = win.opts.webPreferences;
  assert.ok(wp.contextIsolation && wp.sandbox && !wp.nodeIntegration);
  assert.ok(S.handlers["default:kite"] && S.handlers["persist:main:kite"], "served to the interface and inside tabs");
  assert.equal(win.opts.title, "Kite");
});

test("tells sites it's plain Chrome", () => {
  const ua = fake.app.userAgentFallback;
  assert.ok(!/Electron|kite-desktop/i.test(ua), ua);
  assert.match(ua, /Chrome\/140/);
});

test("kite://app/ serves only Kite's own files", async () => {
  const serve = S.handlers["default:kite"];
  const ok = await serve({ url: "kite://app/index.html" });
  assert.match(ok.fetched, /app-ui\/index\.html$/);
  for (const bad of ["kite://app/../main.js", "kite://app/%2e%2e/main.js", "kite://other/index.html", "kite://app/missing.html"]) {
    assert.equal((await serve({ url: bad })).status, 404, bad);
  }
});

test("tabs: create, lay out under the toolbar, show one, navigate", async () => {
  await call("view:create", [1]);
  await call("view:create", [2]);
  const [v1, v2] = S.views;
  assert.equal(win.children.length, 2);
  const wp = v1.opts.webPreferences;
  assert.ok(wp.contextIsolation && wp.sandbox && !wp.nodeIntegration && wp.partition === "persist:main");
  await call("ui:inset", [92]);
  assert.deepEqual(v1.bounds, { x: 0, y: 92, width: 1000, height: 608 });
  await call("view:show", [2]);
  assert.ok(!v1.visible && v2.visible);
  assert.equal(await call("view:navigate", [1, "https://www.youtube.com/"]), true);
  assert.deepEqual(v1.webContents.loaded, ["https://www.youtube.com/"]);
  await call("view:newtab", [2]);
  assert.deepEqual(v2.webContents.loaded, ["kite://app/newtab.html"]);
});

test("unsafe addresses never load", async () => {
  const v1 = S.views[0];
  for (const bad of ["file:///C:/Windows/win.ini", "javascript:alert(1)", "chrome://settings", "devtools://x", "kite://app/../main.js"]) {
    assert.equal(await call("view:navigate", [1, bad]), false, bad);
  }
  assert.equal(v1.webContents.loaded.length, 1);
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  v1.webContents.emit("will-navigate", e, "file:///etc/passwd");
  assert.ok(e.prevented, "pages can't send a tab to file:");
  const e2 = { prevented: false, preventDefault() { this.prevented = true; } };
  v1.webContents.url = "https://evil.example/";
  v1.webContents.emit("will-navigate", e2, "kite://app/newtab.html");
  assert.ok(e2.prevented, "websites can't open Kite's own pages");
  assert.equal(main.allowedUrl("view-source:https://a.test/"), true);
  assert.equal(main.allowedUrl("view-source:file:///etc/passwd"), false);
});

test("only Kite's interface can drive tabs", async () => {
  const site = S.views[0].webContents;
  assert.throws(() => call("view:navigate", [1, "https://evil.example/"], site), /not allowed/);
  assert.throws(() => call("view:navigate", [1, "https://evil.example/"], ui, { parent: {}, url: "kite://app/x" }), /not allowed/);
  assert.throws(() => call("view:navigate", [1, "https://evil.example/"], ui, { parent: null, url: "https://evil.example/" }), /not allowed/);
});

test("page changes reach the interface; the new tab page shows no address", () => {
  const [v1, v2] = S.views;
  v1.webContents.emit("did-navigate", {}, "https://www.youtube.com/watch?v=x");
  v1.webContents.emit("page-title-updated", {}, "A video - YouTube");
  v2.webContents.emit("did-navigate", {}, "kite://app/newtab.html");
  const ev = events().filter((e) => e.type === "page");
  assert.deepEqual(ev.find((e) => e.info.url === "https://www.youtube.com/watch?v=x"), { type: "page", id: 1, info: { url: "https://www.youtube.com/watch?v=x", security: "secure" } });
  assert.ok(ev.some((e) => e.id === 1 && e.info.title === "A video - YouTube"));
  assert.ok(ev.some((e) => e.id === 2 && e.info.url === null && e.info.title === "New Tab"));
});

test("links: new tabs, real pop-ups for sign-in windows, nothing unsafe", () => {
  const open = S.views[0].webContents.openHandler;
  assert.deepEqual(open({ url: "https://a.test/", disposition: "foreground-tab" }), { action: "deny" });
  assert.ok(events().some((e) => e.type === "open" && e.url === "https://a.test/"));
  const pop = open({ url: "https://accounts.google.com/o/oauth2/auth", disposition: "new-window" });
  assert.equal(pop.action, "allow");
  assert.ok(pop.overrideBrowserWindowOptions.webPreferences.sandbox);
  assert.deepEqual(open({ url: "file:///etc/passwd", disposition: "foreground-tab" }), { action: "deny" });
});

test("shortcuts pressed inside a page work", () => {
  const wc = S.views[0].webContents;
  const press = (input) => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    wc.emit("before-input-event", e, { type: "keyDown", ...input });
    return e.prevented;
  };
  const focusedBefore = ui.focused;
  assert.ok(press({ key: "t", control: true }));
  assert.ok(ui.focused > focusedBefore, "the address bar gets the keyboard");
  assert.ok(press({ key: "W", control: true }));
  assert.ok(press({ key: "Tab", control: true, shift: true }));
  assert.ok(press({ key: "ArrowLeft", alt: true }));
  assert.ok(!press({ key: "c", control: true }), "copy still goes to the page");
  const names = events().filter((e) => e.type === "shortcut").map((e) => e.name);
  assert.deepEqual(names, ["new-tab", "close-tab", "prev-tab", "back"]);
  assert.ok(press({ key: "f", control: true }) && press({ key: "=", control: true }) && press({ key: "j", control: true }));
  assert.deepEqual(events().filter((e) => e.type === "shortcut").map((e) => e.name).slice(-3), ["find", "zoom-in", "downloads"]);
  assert.ok(press({ key: "F12" }));
  assert.ok(wc.devtools, "F12 opens the page's DevTools");
});

test("the new tab page's search box; other pages can't use it", () => {
  const [v1, v2] = S.views;
  v2.webContents.url = "kite://app/newtab.html";
  S.ipcOn["newtab:navigate"]({ sender: v2.webContents }, "kites");
  v1.webContents.url = "https://evil.example/";
  S.ipcOn["newtab:navigate"]({ sender: v1.webContents }, "evil");
  const nav = events().filter((e) => e.type === "navigate");
  assert.deepEqual(nav, [{ type: "navigate", id: 2, input: "kites" }]);
});

test("permissions: the window showing the site asks you; remembered when you say so", async () => {
  const [v1] = S.views;
  const ses = S.sessions["persist:main"];
  const ask = (perm, details) => new Promise((r) => ses.request(v1.webContents, perm, r, details));
  assert.equal(await ask("fullscreen", {}), true);
  assert.equal(await ask("usb", {}), false);
  const pending = ask("media", { mediaTypes: ["video"], requestingUrl: "https://meet.example/room" });
  await tick();
  const q = events().filter((e) => e.type === "permission").at(-1);
  assert.deepEqual(q.request.text, "use your camera");
  assert.equal(q.request.origin, "https://meet.example");
  assert.equal(q.request.tabId, 1);
  await call("permission:answer", [q.request.id, true, true]);
  assert.equal(await pending, true);
  assert.ok(events().some((e) => e.type === "permission-done" && e.id === q.request.id));
  assert.equal(await ask("media", { mediaTypes: ["video"], requestingUrl: "https://meet.example/" }), true, "remembered: not asked again");
  v1.webContents.url = "https://meet.example/room";
  assert.deepEqual((await call("site:info", [1])).permissions, { camera: "allow" });
  await call("site:reset-permissions", [1]);
  assert.deepEqual((await call("site:info", [1])).permissions, {});
  // a question for a tab that navigates away is answered "no"
  const left = ask("geolocation", { requestingUrl: "https://meet.example/" });
  await tick();
  v1.webContents.emit("did-navigate", {}, "https://other.example/");
  assert.equal(await left, false);
});

test("back, reload, fullscreen video, closing a tab", async () => {
  const [v1] = S.views;
  await call("view:command", [1, "back"]);
  await call("view:command", [1, "reload"]);
  assert.deepEqual(v1.webContents.loaded.slice(-2), ["<back>", "<reload>"]);
  v1.webContents.emit("enter-html-full-screen");
  assert.ok(win.fullscreen);
  assert.deepEqual(v1.bounds, { x: 0, y: 0, width: 1000, height: 700 });
  v1.webContents.emit("leave-html-full-screen");
  assert.equal(v1.bounds.y, 92);
  await call("view:close", [1]);
  assert.ok(v1.webContents.closed && !win.children.includes(v1));
});

test("sites' pop-up windows: no file: addresses, no webviews, only websites in further windows", () => {
  const wc = new (fake.BrowserWindow)({}).webContents;
  fake.app.emit("web-contents-created", {}, wc);
  const nav = (url) => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    wc.emit("will-navigate", e, url);
    return e.prevented;
  };
  assert.equal(nav("https://accounts.google.com/"), false);
  assert.equal(nav("file:///C:/Windows/win.ini"), true);
  assert.equal(nav("chrome://settings"), true);
  const w = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit("will-attach-webview", w);
  assert.ok(w.prevented);
  assert.equal(wc.openHandler({ url: "https://a.test/" }).action, "allow");
  assert.ok(wc.openHandler({ url: "https://a.test/" }).overrideBrowserWindowOptions.webPreferences.sandbox);
  assert.equal(wc.openHandler({ url: "file:///x" }).action, "deny");
});

test("mailto: links go to your mail app", () => {
  const wc = new (fake.BrowserWindow)({}).webContents;
  fake.app.emit("web-contents-created", {}, wc);
  const e = { preventDefault() { this.prevented = true; } };
  wc.emit("will-navigate", e, "mailto:me@example.com");
  assert.ok(e.prevented);
  assert.deepEqual(S.external, ["mailto:me@example.com"]);
});

test("find in page, zoom, print, PDF", async () => {
  await call("view:create", [5]);
  const v = S.views.at(-1);
  await call("view:find", [5, "kite", { forward: true }]);
  await call("view:find", [5, "kite", { findNext: true, forward: false }]);
  await call("view:stop-find", [5]);
  assert.deepEqual(v.webContents.finds, [["kite", { forward: true, findNext: false, matchCase: false }], ["kite", { forward: false, findNext: true, matchCase: false }], ["<stop>", "clearSelection"]]);
  v.webContents.emit("found-in-page", {}, { activeMatchOrdinal: 2, matches: 7, finalUpdate: true });
  assert.ok(events().some((e) => e.type === "find" && e.id === 5 && e.active === 2 && e.total === 7));
  await call("view:zoom", [5, "in"]);
  await call("view:zoom", [5, "in"]);
  assert.equal(v.webContents.getZoomFactor(), 1.25);
  v.webContents.emit("zoom-changed", {}, "out");
  assert.equal(v.webContents.getZoomFactor(), 1.1);
  await call("view:zoom", [5, "reset"]);
  assert.equal(events().filter((e) => e.type === "zoom").at(-1).percent, 100);
  await call("view:command", [5, "print"]);
  assert.ok(v.webContents.printed);
  v.webContents.url = "https://a.test/";
  v.webContents.getTitle = () => "My: page?";
  assert.equal(await call("view:pdf", [5]), true);
  assert.ok(fs.existsSync(path.join(S.paths.downloads, "My_ page_.pdf")));
});

test("pages that can't load show Kite's error page; the address bar keeps the address; reload retries", async () => {
  const v = S.views.at(-1);
  v.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://nope.example/", true);
  assert.match(v.webContents.url, /^kite:\/\/app\/error\.html\?u=https%3A%2F%2Fnope\.example%2F&c=-105/);
  v.webContents.emit("did-navigate", {}, v.webContents.url);
  const ev = events().filter((e) => e.type === "page" && e.id === 5).at(-1);
  assert.deepEqual(ev.info, { url: "https://nope.example/", security: "error" });
  await call("view:command", [5, "reload"]);
  assert.equal(v.webContents.url, "https://nope.example/");
  const before = v.webContents.loaded.length;
  v.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://x.example/", true);
  v.webContents.emit("did-fail-load", {}, -105, "x", "https://ad.example/", false);
  assert.equal(v.webContents.loaded.length, before, "cancelled loads and frames don't show it");
});

test("right-click menu: real menu, actions on the page", () => {
  const v = S.views.at(-1);
  v.webContents.emit("context-menu", {}, { x: 3, y: 4, linkURL: "https://b.test/", pageURL: "https://a.test/" });
  const pop = S.popups.at(-1);
  assert.equal(pop.opts.window, win);
  const item = (label) => pop.template.find((i) => i.label === label);
  item("Open link in new tab").click();
  assert.ok(events().some((e) => e.type === "open" && e.url === "https://b.test/"));
  item("Copy link address").click();
  assert.deepEqual(S.clipboard.at(-1), "https://b.test/");
  item("Save link as\u2026").click();
  assert.deepEqual(v.webContents.downloads, ["https://b.test/"]);
  item("Inspect").click();
  assert.deepEqual(v.webContents.inspected, [3, 4]);
  const windowsBefore = S.windows.length;
  item("Open link in new window").click();
  assert.equal(S.windows.length, windowsBefore + 1, "a new window, same profile");
});

test("tab and app menus resolve to what was picked", async () => {
  const pTab = call("menu:tab", [{ count: 3, canReopen: true }]);
  S.popups.at(-1).template.find((i) => i.label === "Duplicate").click();
  assert.equal(await pTab, "duplicate");
  const pApp = call("menu:app", []);
  S.popups.at(-1).template.find((i) => i.label === "Find\u2026").click();
  assert.equal(await pApp, "find");
  const pNone = call("menu:app", []);
  S.popups.at(-1).opts.callback(); // closed without picking
  assert.equal(await pNone, null);
});

test("windows, guest windows and profiles: separate sessions, events to the right window", async () => {
  const count = S.windows.length;
  const pGuest = call("menu:app", []);
  S.popups.at(-1).template.find((i) => i.label === "New guest window").click();
  assert.equal(await pGuest, null, "done by the app, nothing for the interface");
  const guest = S.windows[count];
  assert.equal(guest.opts.title, "Kite (Guest)");
  const guestUi = guest.webContents;
  guestUi.url = "kite://app/index.html";
  const gcall = (name, args) => S.ipcHandle[name]({ sender: guestUi, senderFrame: guestUi.mainFrame }, ...args);
  await gcall("view:create", [1]);
  const gv = S.views.at(-1);
  assert.match(gv.opts.webPreferences.partition, /^guest-[0-9a-f]+$/, "in memory, not persist:");
  assert.equal((await gcall("profiles:list", [])).current.guest, true);
  gv.webContents.emit("page-title-updated", {}, "Guest page");
  assert.ok(guestUi.sent.some(([, e]) => e.info && e.info.title === "Guest page"));
  assert.ok(!events().some((e) => e.info && e.info.title === "Guest page"), "not sent to the main window");
  const gses = S.sessions[gv.opts.webPreferences.partition];
  guest.close();
  assert.deepEqual(gses.cleared, ["all"], "a guest leaves nothing behind");

  const added = await call("profiles:add", ["Work"]);
  const work = S.windows.at(-1);
  assert.equal(work.opts.title, "Kite (Work)");
  assert.deepEqual((await call("profiles:list", [])).list.map((p) => p.name), ["Main", "Work"]);
  assert.equal(await call("profiles:remove", ["main"]), false);
  assert.equal(await call("profiles:remove", [added.id]), true);
  assert.ok(work.destroyed, "its windows close");
  assert.deepEqual(S.sessions["persist:profile-" + added.id].cleared, ["all"], "its data is deleted");
});

test("downloads reach the profile's windows; actions only for that profile", async () => {
  const ses = S.sessions["persist:main"];
  const { EventEmitter } = await import("node:events");
  const item = new EventEmitter();
  Object.assign(item, { getFilename: () => "kite.zip", getURL: () => "https://f.test/kite.zip", getTotalBytes: () => 10, getReceivedBytes: () => 10,
    isPaused: () => false, canResume: () => false, setSavePath(p) { this.savePath = p; }, cancel() {} });
  ses.emit("will-download", {}, item);
  assert.equal(item.savePath, path.join(S.paths.downloads, "kite.zip"));
  item.emit("done", {}, "completed");
  const list = events().filter((e) => e.type === "downloads").at(-1).list;
  assert.equal(list[0].filename, "kite.zip");
  assert.equal(list[0].state, "completed");
  assert.deepEqual(await call("downloads:list", []), list);
  assert.equal(await call("downloads:action", [list[0].id, "show"]), true);
  assert.equal(S.external.at(-1), "show:" + path.join(S.paths.downloads, "kite.zip"));
});

test("history, bookmarks, settings: saved per profile, shared with its windows, guests in memory", async () => {
  assert.equal(await call("data:load", ["bookmarks"]), null);
  assert.equal(await call("data:save", ["bookmarks", [{ id: "a", url: "https://a.test/", title: "A" }]]), true);
  assert.deepEqual(await call("data:load", ["bookmarks"]), [{ id: "a", url: "https://a.test/", title: "A" }], "read back at once");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(S.paths.userData, "profile-data", "main", "bookmarks.json"), "utf8")), [{ id: "a", url: "https://a.test/", title: "A" }], "then on disk");
  assert.equal(await call("data:save", ["../../evil", "x"]), false, "only Kite's own kinds of data");
  assert.equal(await call("data:load", ["../profiles"]), null);
  // another window of the same profile hears about it
  const before = S.windows.length;
  await call("window:new", []);
  const second = S.windows[before];
  second.webContents.url = "kite://app/index.html";
  await call("data:save", ["settings", { searchEngine: "google" }]);
  assert.ok(second.webContents.sent.some(([, e]) => e.type === "data" && e.name === "settings" && e.value.searchEngine === "google"));
  // a guest window: separate, in memory, gone when closed
  await call("window:guest", []);
  const guest = S.windows.at(-1);
  guest.webContents.url = "kite://app/index.html";
  const g = (name, args) => S.ipcHandle[name]({ sender: guest.webContents, senderFrame: guest.webContents.mainFrame }, ...args);
  assert.equal(await g("data:load", ["bookmarks"]), null, "guests don't see the profile's bookmarks");
  await g("data:save", ["history", [{ url: "https://secret.test/", time: 1 }]]);
  assert.deepEqual(await g("data:load", ["history"]), [{ url: "https://secret.test/", time: 1 }]);
  const files = fs.readdirSync(path.join(S.paths.userData, "profile-data"));
  assert.ok(!files.some((f) => f.startsWith("guest")), "nothing written to disk");
  guest.close();
});

test("new shortcuts from inside a page: history, bookmark, bookmarks bar, home", () => {
  const press = (input) => main.shortcutFor({ type: "keyDown", ...input });
  assert.equal(press({ key: "h", control: true }), "history");
  assert.equal(press({ key: "d", control: true }), "bookmark");
  assert.equal(press({ key: "B", control: true, shift: true }), "bookmarks-bar");
  assert.equal(press({ key: "O", control: true, shift: true }), "bookmarks");
  assert.equal(press({ key: "Home", alt: true }), "home");
});

test("Kite DevTools: requests, page errors, crashes and permissions, per profile", async () => {
  await call("view:create", [901]);
  const view = S.views[S.views.length - 1];
  const wc = view.webContents;
  const ses = S.sessions["persist:main"];
  const wr = ses.webRequest.listeners;
  const start = (await call("devtools:events", [0])).next;
  wr.sendHeaders({ id: 1, url: "https://site.test/a.js", timestamp: 1000 });
  wr.completed({ id: 1, url: "https://site.test/a.js", method: "GET", webContentsId: wc.id, resourceType: "script", statusCode: 200, fromCache: false, timestamp: 1042,
    responseHeaders: { "Content-Type": ["text/javascript; charset=utf-8"], "Content-Length": ["1234"] } });
  wr.error({ id: 2, url: "https://site.test/b.png", method: "GET", webContentsId: wc.id, resourceType: "image", error: "net::ERR_NAME_NOT_RESOLVED" });
  wr.completed({ id: 3, url: "kite://app/newtab.html", method: "GET", statusCode: 200 }); // Kite's own pages aren't listed
  wc.emit("console-message", { level: "error", message: "Uncaught TypeError: x is not a function", lineNumber: 3, sourceId: "https://site.test/a.js" });
  wc.emit("console-message", { level: "info", message: "just chatter" });
  wc.emit("console-message", {}, 2, "old style warning", 9, "https://site.test/c.js"); // Electron before 35
  wc.url = "https://site.test/";
  wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
  const { events: list, next } = await call("devtools:events", [start]);
  const reqs = list.filter((e) => e.type === "request");
  assert.equal(reqs.length, 2);
  assert.deepEqual({ ...reqs[0], id: 0, time: 0 }, { id: 0, time: 0, type: "request", method: "GET", url: "https://site.test/a.js", dest: "script", tab: 901, ms: 42, status: 200, source: "network", contentType: "text/javascript", bytes: 1234 });
  assert.equal(reqs[1].error, "net::ERR_NAME_NOT_RESOLVED");
  assert.equal(reqs[1].status, 0);
  const logs = list.filter((e) => e.type === "log").map((e) => `${e.level} ${e.text}`);
  assert.deepEqual(logs, [
    "error [page error] Uncaught TypeError: x is not a function (https://site.test/a.js:3)",
    "warn [page warning] old style warning (https://site.test/c.js:9)",
    "error [PAGE CRASH] https://site.test/: crashed (exit code 5)",
  ]);
  assert.ok(!("profile" in list[0]), "the profile id stays inside the app");
  assert.deepEqual((await call("devtools:events", [next])).events, []);

  // Another profile's window sees none of this.
  await call("window:guest", []);
  const gw = S.windows[S.windows.length - 1];
  const gEvents = await call("devtools:events", [0], gw.webContents);
  assert.equal(gEvents.events.filter((e) => e.url === "https://site.test/a.js").length, 0);

  const st = await call("devtools:status", []);
  assert.equal(st.profile.id, "main");
  assert.ok(st.tabs >= 1 && st.windows >= 1);
  assert.deepEqual(st.memory, { processes: 2, kb: 3000 });
  assert.ok(st.events >= 5);
  await call("devtools:clear", []);
  assert.equal((await call("devtools:events", [0])).events.length, 0);
  gw.close();
});

test("Kite DevTools is only for Kite's own interface", async () => {
  const view = S.views[S.views.length - 1];
  assert.throws(() => call("devtools:events", [0], view.webContents), /not allowed/);
});

test("Kite Search: the app asks the Kite backend, and passes on only plain results", async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, json: async () => ({ total: 2, took: 3, pages: 99, results: [
      { url: "https://kites.test/", title: "Kites", snippet: [{ text: "about ", hit: false }, { text: "kites", hit: true }], extra: "<b>x</b>" },
      { url: "javascript:alert(1)", title: "bad" },
    ] }) };
  };
  try {
    const r = await call("search:query", ["red kites", 2]);
    assert.equal(asked[0], "https://kite-api.cat-code.org/__kite/search?q=red+kites&page=2");
    assert.deepEqual(r.results, [{ url: "https://kites.test/", title: "Kites", host: "", snippet: [{ text: "about ", hit: false }, { text: "kites", hit: true }], missing: [] }]);
    assert.equal(r.pages, 99);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.match((await call("search:query", ["x", 1])).error, /Couldn't reach Kite Search/);
  } finally {
    globalThis.fetch = real;
  }
});
