// Part 5: account data (history, bookmarks...) and linking the Kite app.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKiteServer } from "../app.js";
import { resetLimits } from "../kite-api.js";
import { mergeData, putData } from "../accountdata.js";

const UI = "http://localhost:3000";
async function start(file = null) {
  resetLimits();
  const k = createKiteServer({ allowedOrigins: [UI], allowPrivate: true, allowedPorts: null, cookieFile: file, log: () => {} });
  await new Promise((r) => k.server.listen(0, "127.0.0.1", r));
  return { ...k, url: `http://127.0.0.1:${k.server.address().port}`, stop: () => (k.server.closeAllConnections(), k.server.close()) };
}
// A browser with the Kite UI open (its own kite_sid).
function browser(base) {
  let sid = "";
  return async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { origin: UI, cookie: sid, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get("set-cookie");
    if (set) sid = set.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const app = (base, token) => async (method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test("merging: history keeps both devices' visits, bookmarks both additions, settings the newest", () => {
  assert.deepEqual(mergeData("history", [{ url: "a", time: 1 }, { url: "b", time: 3 }], [{ url: "c", time: 2 }, { url: "b", time: 3 }]).map((v) => v.url), ["b", "c", "a"]);
  assert.deepEqual(mergeData("bookmarks", [{ url: "a" }, { url: "b" }], [{ url: "b", title: "new" }, { url: "c" }]), [{ url: "b", title: "new" }, { url: "c" }, { url: "a" }]);
  assert.deepEqual(mergeData("settings", { x: 1 }, { x: 2 }), { x: 2 });
  const account = {};
  const first = putData(account, "bookmarks", [{ url: "a" }], 0);
  assert.equal(putData(account, "bookmarks", [], first.updated).value.length, 0, "seen the latest: a delete is a delete");
  const v2 = putData(account, "bookmarks", [{ url: "x" }], 0);
  assert.ok(!v2.merged || v2.value.some((b) => b.url === "x"));
  assert.equal(putData(account, "evil", 1, 0).error, "unknown data");
});

test("Kite Web: signed in, your data is kept in your account; guests and other sites can't", async () => {
  const k = await start();
  const b = browser(k.url);
  assert.equal((await b("GET", "/__kite/data")).status, 401, "a guest has no account data");
  await b("POST", "/__kite/account/signup", { username: "ella", password: "correct horse" });
  assert.deepEqual((await b("GET", "/__kite/data")).body, {});
  const put = await b("PUT", "/__kite/data/bookmarks", { value: [{ id: "1", url: "https://a.test/", title: "A" }], base: 0 });
  assert.equal(put.status, 200);
  const all = (await b("GET", "/__kite/data")).body;
  assert.deepEqual(all.bookmarks.value, [{ id: "1", url: "https://a.test/", title: "A" }]);
  assert.equal(all.bookmarks.updated, put.body.updated);
  assert.equal((await b("PUT", "/__kite/data/../../x", { value: 1 })).status, 404);
  const evil = await fetch(k.url + "/__kite/data", { headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  // another device, same account
  const b2 = browser(k.url);
  await b2("POST", "/__kite/account/signin", { username: "ella", password: "correct horse" });
  assert.deepEqual((await b2("GET", "/__kite/data")).body.bookmarks.value[0].url, "https://a.test/");
  k.stop();
});

test("linking the Kite app: one-time code, token, sync, unlink", async () => {
  const k = await start();
  const b = browser(k.url);
  await b("POST", "/__kite/account/signup", { username: "sam", password: "password123" });
  const { code } = (await b("POST", "/__kite/sync/link-code", {})).body;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const anon = app(k.url);
  assert.equal((await anon("POST", "/__kite/sync/token", { code: "AAAA-AAAA" })).status, 400);
  const linked = await anon("POST", "/__kite/sync/token", { code: code.toLowerCase().replace("-", " "), device: "Kite app on Desktop" });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.user, "sam");
  assert.equal((await anon("POST", "/__kite/sync/token", { code })).status, 400, "a code works once");
  const a = app(k.url, linked.body.token);
  assert.equal((await app(k.url, "x".repeat(43))("GET", "/__kite/data")).status, 401);
  const put = await a("PUT", "/__kite/data/history", { value: [{ url: "https://from.app/", time: 5 }], base: 0 });
  assert.equal(put.status, 200);
  assert.deepEqual((await b("GET", "/__kite/data")).body.history.value, [{ url: "https://from.app/", time: 5 }], "Kite Web sees it");
  // Kite Web adds a visit without having seen the app's: both are kept
  const web = await b("PUT", "/__kite/data/history", { value: [{ url: "https://from.web/", time: 9 }], base: 0 });
  assert.deepEqual(web.body.value.map((v) => v.url), ["https://from.web/", "https://from.app/"]);
  const dev = (await b("GET", "/__kite/sync/devices")).body.devices;
  assert.equal(dev.length, 1);
  assert.equal(dev[0].device, "Kite app on Desktop");
  assert.ok(dev[0].lastUsed > 0);
  await b("POST", "/__kite/sync/unlink", { id: dev[0].id });
  assert.equal((await a("GET", "/__kite/data")).status, 401, "unlinked from Kite Web: the app is locked out");
  k.stop();
});

test("code guessing is limited; tokens are stored only as hashes", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kite-sync-")), "c.json");
  const k = await start(file);
  const b = browser(k.url);
  await b("POST", "/__kite/account/signup", { username: "lee", password: "password123" });
  const { code } = (await b("POST", "/__kite/sync/link-code", {})).body;
  const { token } = (await app(k.url)("POST", "/__kite/sync/token", { code })).body;
  k.sessions.save();
  assert.ok(!fs.readFileSync(file, "utf8").includes(token));
  for (let i = 0; i < 10; i++) await app(k.url)("POST", "/__kite/sync/token", { code: "ZZZZ-ZZZZ" });
  assert.equal((await app(k.url)("POST", "/__kite/sync/token", { code: "ZZZZ-ZZZZ" })).status, 429);
  k.stop();
  const k2 = await start(file);
  assert.equal((await app(k2.url, token)("GET", "/__kite/data")).status, 200, "still linked after a restart");
  k2.stop();
});
