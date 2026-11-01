// Kite accounts: sign up, sign in, your cookie jar on every device, sign out.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKiteServer } from "../app.js";
import { resetLimits } from "../kite-api.js";

const UI = "http://localhost:3000";
async function start(file) {
  resetLimits();
  const k = createKiteServer({ allowedOrigins: [UI], allowPrivate: true, allowedPorts: null, cookieFile: file, log: () => {} });
  await new Promise((r) => k.server.listen(0, "127.0.0.1", r));
  return { ...k, url: `http://127.0.0.1:${k.server.address().port}` };
}
// One "device": a browser with its own kite_sid cookie.
function device(base) {
  let sid = "";
  return async function call(p, body, origin = UI) {
    const r = await fetch(base + "/__kite/account" + p, {
      method: body ? "POST" : "GET",
      headers: { origin, cookie: sid, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get("set-cookie");
    if (set) sid = set.split(";")[0];
    return { status: r.status, ...(await r.json().catch(() => ({}))), sid: () => sid };
  };
}

test("sign up, then the account's jar follows you to another device", async () => {
  const k = await start(null);
  const a = device(k.url);
  assert.equal((await a("")).user, null, "starts as a guest");
  assert.equal((await a("/signup", { username: "Ella", password: "short" })).status, 400);
  const made = await a("/signup", { username: "Ella", password: "correct horse" });
  assert.equal(made.user, "ella");
  assert.equal((await a("/signup", { username: "ella", password: "another one" })).status, 400, "taken");
  // a cookie lands in the account's jar
  const jarA = k.sessions.jarFor({ headers: { cookie: made.sid() } });
  jarA.set("SID=abc; Path=/; Secure", "https://www.youtube.com/");
  // device B signs in and sees the same jar
  const b = device(k.url);
  await b("");
  assert.equal((await b("/signin", { username: "ella", password: "wrong pass" })).status, 401);
  const inB = await b("/signin", { username: "ELLA", password: "correct horse" });
  assert.equal(inB.user, "ella");
  assert.equal(k.sessions.jarFor({ headers: { cookie: inB.sid() } }).header("https://www.youtube.com/"), "SID=abc");
  // signing out gives an empty guest jar
  const out = await b("/signout", {});
  assert.equal(out.user, null);
  assert.equal(k.sessions.jarFor({ headers: { cookie: out.sid() } }).header("https://www.youtube.com/"), "");
  k.server.closeAllConnections(); k.server.close();
});

test("only the Kite UI can use accounts", async () => {
  const k = await start(null);
  const evil = device(k.url);
  assert.equal((await evil("/signup", { username: "mallory", password: "12345678" }, "https://evil.example")).status, 403);
  k.server.closeAllConnections(); k.server.close();
});

test("a fresh session id on sign-in; sign out everywhere ends all of them", async () => {
  const k = await start(null);
  const a = device(k.url);
  const guest = (await a("")).sid();
  const signed = (await a("/signup", { username: "sam", password: "password123" })).sid();
  assert.notEqual(signed, guest);
  const b = device(k.url);
  await b("/signin", { username: "sam", password: "password123" });
  await a("/signout-everywhere", {});
  assert.equal((await b("")).user, null, "the other device was signed out too");
  k.server.closeAllConnections(); k.server.close();
});

test("repeated wrong passwords are slowed down", async () => {
  const k = await start(null);
  const a = device(k.url);
  await a("/signup", { username: "lock", password: "password123" });
  const x = device(k.url);
  for (let i = 0; i < 5; i++) await x("/signin", { username: "lock", password: "nope-nope" + i });
  const r = await x("/signin", { username: "lock", password: "password123" });
  assert.equal(r.status, 429, "even the right password waits");
  assert.match(r.error, /Try again in \d+ seconds/);
  k.server.closeAllConnections(); k.server.close();
});

test("accounts and their cookies survive a restart; passwords are not stored", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kite-acc-")), "c.json");
  let k = await start(file);
  const a = device(k.url);
  const sid = (await a("/signup", { username: "keep", password: "my secret pass" })).sid();
  k.sessions.jarFor({ headers: { cookie: sid } }).set("A=1; Path=/; Max-Age=3600", "https://example.com/");
  k.sessions.save();
  k.server.closeAllConnections(); k.server.close();
  const saved = fs.readFileSync(file, "utf8");
  assert.ok(!saved.includes("my secret pass"));
  k = await start(file);
  const b = device(k.url);
  const r = await b("/signin", { username: "keep", password: "my secret pass" });
  assert.equal(r.user, "keep");
  assert.equal(k.sessions.jarFor({ headers: { cookie: r.sid() } }).header("https://example.com/"), "A=1");
  k.server.closeAllConnections(); k.server.close();
});
