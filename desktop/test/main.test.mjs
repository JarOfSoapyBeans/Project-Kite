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
  const ev = events();
  assert.deepEqual(ev.find((e) => e.info.url === "https://www.youtube.com/watch?v=x"), { type: "page", id: 1, info: { url: "https://www.youtube.com/watch?v=x" } });
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

test("sites get no camera, microphone or location until Kite asks (part 3)", () => {
  const ses = S.sessions["persist:main"];
  const ask = (p) => new Promise((r) => ses.request(null, p, r));
  return Promise.all([ask("media"), ask("geolocation"), ask("notifications"), ask("fullscreen")]).then((r) => assert.deepEqual(r, [false, false, false, true]));
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

test("mailto: links go to your mail app", () => {
  const wc = new (fake.BrowserWindow)({}).webContents;
  fake.app.emit("web-contents-created", {}, wc);
  const e = { preventDefault() { this.prevented = true; } };
  wc.emit("will-navigate", e, "mailto:me@example.com");
  assert.ok(e.prevented);
  assert.deepEqual(S.external, ["mailto:me@example.com"]);
});
