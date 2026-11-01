// The app syncing a profile with a Kite account, against a real Kite backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createKiteServer } from "../../backend/app.js";
import { resetLimits } from "../../backend/kite-api.js";
const require = createRequire(import.meta.url);
const { Sync } = require("../lib/sync.js");

const UI = "http://localhost:3000";
async function backend() {
  resetLimits();
  const k = createKiteServer({ allowedOrigins: [UI], allowPrivate: true, allowedPorts: null, log: () => {} });
  await new Promise((r) => k.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${k.server.address().port}`;
  let sid = "";
  const web = async (method, p, body) => {
    const r = await fetch(url + p, { method, headers: { origin: UI, cookie: sid, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = r.headers.get("set-cookie");
    if (set) sid = set.split(";")[0];
    return r.json().catch(() => null);
  };
  await web("POST", "/__kite/account/signup", { username: "ella", password: "correct horse" });
  return { k, url, web, stop: () => (k.server.closeAllConnections(), k.server.close()) };
}
// A profile's local data, in memory.
function profileData() {
  const files = {};
  const told = [];
  return {
    files, told,
    read: (_p, n) => (n in files ? structuredClone(files[n]) : null),
    write: (_p, n, v) => (files[n] = structuredClone(v)),
    changed: (_p, n, v) => told.push([n, v]),
  };
}

test("link with a code: the account's data arrives, the app's goes up, nothing is wiped", async () => {
  const b = await backend();
  await b.web("PUT", "/__kite/data/bookmarks", { value: [{ id: "w", url: "https://web.test/", title: "From Kite Web" }], base: 0 });
  const local = profileData();
  local.files.history = [{ url: "https://app.test/", title: "From the app", time: 10 }];
  const sync = new Sync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "kite-sync-")), ...local, device: "Test PC" });
  assert.deepEqual(await sync.link("main", b.url, "WRONG-CODE"), { error: "That code is wrong or has expired. Make a new one in Kite Web." });
  assert.equal((await sync.link("main", "file:///x", "x")).error, "Enter your Kite address, like https://kite-api.example.com");
  const { code } = await b.web("POST", "/__kite/sync/link-code", {});
  const st = await sync.link("main", b.url + "/some/path", code);
  assert.equal(st.linked, true);
  assert.equal(st.user, "ella");
  assert.equal(st.backend, b.url);
  assert.deepEqual(local.files.bookmarks, [{ id: "w", url: "https://web.test/", title: "From Kite Web" }], "the account's bookmarks arrived");
  assert.ok(local.told.some(([n]) => n === "bookmarks"), "the profile's windows were told");
  const acct = await b.web("GET", "/__kite/data");
  assert.deepEqual(acct.history.value, [{ url: "https://app.test/", title: "From the app", time: 10 }], "the app's history went up");
  assert.deepEqual(acct.bookmarks.value.length, 1, "not wiped");
  const devices = (await b.web("GET", "/__kite/sync/devices")).devices;
  assert.equal(devices[0].device, "Test PC");
  b.stop();
});

test("after that: changes go both ways; changes on both sides are merged", async () => {
  const b = await backend();
  const local = profileData();
  const sync = new Sync({ dir: null, ...local });
  const { code } = await b.web("POST", "/__kite/sync/link-code", {});
  await sync.link("main", b.url, code);
  // the app adds a bookmark
  local.files.bookmarks = [{ id: "a", url: "https://a.test/", title: "A" }];
  sync.noteChange("main", "bookmarks");
  await sync.syncNow("main");
  const acct = await b.web("GET", "/__kite/data");
  assert.deepEqual(acct.bookmarks.value.map((x) => x.url), ["https://a.test/"]);
  // Kite Web changes settings
  await b.web("PUT", "/__kite/data/settings", { value: { searchEngine: "google" }, base: 0 });
  await sync.syncNow("main");
  assert.equal(local.files.settings.searchEngine, "google");
  // both add a bookmark before syncing
  await b.web("PUT", "/__kite/data/bookmarks", { value: [...acct.bookmarks.value, { id: "w", url: "https://w.test/", title: "W" }], base: acct.bookmarks.updated });
  local.files.bookmarks = [...local.files.bookmarks, { id: "p", url: "https://p.test/", title: "P" }];
  sync.noteChange("main", "bookmarks");
  await sync.syncNow("main");
  assert.deepEqual(local.files.bookmarks.map((x) => x.url).sort(), ["https://a.test/", "https://p.test/", "https://w.test/"]);
  assert.deepEqual((await b.web("GET", "/__kite/data")).bookmarks.value.map((x) => x.url).sort(), ["https://a.test/", "https://p.test/", "https://w.test/"]);
  // the app deletes one: deleted everywhere
  local.files.bookmarks = local.files.bookmarks.filter((x) => x.url !== "https://a.test/");
  sync.noteChange("main", "bookmarks");
  await sync.syncNow("main");
  assert.ok(!(await b.web("GET", "/__kite/data")).bookmarks.value.some((x) => x.url === "https://a.test/"));
  b.stop();
});

test("unlinking: from the app, or from Kite Web (the app notices)", async () => {
  const b = await backend();
  const local = profileData();
  const sync = new Sync({ dir: null, ...local });
  let { code } = await b.web("POST", "/__kite/sync/link-code", {});
  await sync.link("main", b.url, code);
  assert.equal((await sync.unlink("main")).linked, false);
  assert.deepEqual((await b.web("GET", "/__kite/sync/devices")).devices, [], "the backend forgot it");
  ({ code } = await b.web("POST", "/__kite/sync/link-code", {}));
  await sync.link("main", b.url, code);
  await b.web("POST", "/__kite/sync/unlink", { id: "all" });
  const st = await sync.syncNow("main");
  assert.equal(st.linked, false);
  assert.equal(st.error, "This app was unlinked from your Kite account.");
  b.stop();
});
