// Stage 4: the cookie jar, sessions, cookies through the proxy, and /__kite/ endpoints.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CookieJar, siteOf, isPublicSuffix, requestContext } from "../cookies.js";
import { Sessions } from "../sessions.js";
import { handleKiteApi } from "../kite-api.js";
import { handleProxy, toProxyUrl as P } from "../proxy.js";

// ---------- the jar's rules ----------

test("sites and public suffixes", () => {
  assert.equal(siteOf("www.example.com"), "example.com");
  assert.equal(siteOf("a.b.example.co.uk"), "example.co.uk");
  assert.equal(siteOf("me.github.io"), "me.github.io");
  assert.equal(siteOf("127.0.0.1"), "127.0.0.1");
  assert.ok(isPublicSuffix("com") && isPublicSuffix("co.uk") && isPublicSuffix("vercel.app"));
  assert.ok(!isPublicSuffix("example.com"));
});

test("domain, path, secure and host-only matching", () => {
  const jar = new CookieJar();
  assert.ok(jar.set("a=1", "https://www.example.com/docs/page"));
  assert.ok(jar.set("b=2; Domain=example.com; Path=/", "https://www.example.com/"));
  assert.ok(jar.set("c=3; Secure; Path=/", "https://www.example.com/"));
  assert.equal(jar.set("d=4; Domain=other.com", "https://www.example.com/"), false, "can't set for another site");
  assert.equal(jar.set("e=5; Domain=com", "https://www.example.com/"), false, "can't set for a public suffix");
  assert.equal(jar.set("f=6; Domain=co.uk", "https://shop.co.uk/"), false);
  assert.equal(jar.set("g=7; Secure", "http://www.example.com/"), false, "insecure page can't set Secure");

  assert.equal(jar.header("https://www.example.com/docs/x"), "a=1; b=2; c=3", "default path is /docs");
  assert.equal(jar.header("https://www.example.com/other"), "b=2; c=3");
  assert.equal(jar.header("http://www.example.com/docs/x"), "a=1; b=2", "Secure only over https");
  assert.equal(jar.header("https://api.example.com/"), "b=2", "host-only a=1 and c=3 not sent to api.");
  assert.equal(jar.header("https://example.org/"), "");
});

test("expiry, deletion, HttpOnly and prefixes", () => {
  const jar = new CookieJar();
  jar.set("s=1; HttpOnly; Path=/", "https://x.test/");
  jar.set("t=1; Max-Age=3600; Path=/", "https://x.test/");
  jar.set("old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/", "https://x.test/");
  assert.equal(jar.header("https://x.test/"), "s=1; t=1");
  assert.equal(jar.scriptCookies("https://x.test/"), "t=1", "document.cookie never sees HttpOnly");
  assert.equal(jar.set("s=hacked; Path=/", "https://x.test/", { fromScript: true }), false, "scripts can't overwrite HttpOnly");
  assert.equal(jar.set("u=1; HttpOnly", "https://x.test/", { fromScript: true }), false);
  jar.set("t=; Max-Age=0; Path=/", "https://x.test/");
  assert.equal(jar.header("https://x.test/"), "s=1");
  assert.equal(jar.set("__Host-a=1; Path=/", "https://x.test/"), false, "__Host- needs Secure");
  assert.ok(jar.set("__Host-a=1; Secure; Path=/", "https://x.test/"));
  assert.equal(jar.set("__Host-b=1; Secure; Path=/; Domain=x.test", "https://x.test/"), false, "__Host- must be host-only");
  assert.equal(jar.set("__Secure-c=1", "https://x.test/"), false);
});

test("third-party cookies are blocked; SameSite on cross-site navigation", () => {
  const jar = new CookieJar();
  jar.set("lax=1; Path=/", "https://mail.test/");
  jar.set("strict=1; SameSite=Strict; Path=/", "https://mail.test/");
  jar.set("none=1; SameSite=None; Secure; Path=/", "https://mail.test/");
  assert.equal(jar.header("https://mail.test/", { crossSite: false }), "lax=1; strict=1; none=1");
  assert.equal(jar.header("https://mail.test/", { crossSite: true, topLevel: false }), "", "no third-party cookies");
  assert.equal(jar.header("https://mail.test/", { crossSite: true, topLevel: true }), "lax=1; none=1");
});

test("request context: only your own navigations count as top-level", () => {
  const req = (h, method = "GET") => ({ method, headers: h });
  const evil = new URL("https://evil.test/");
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
  assert.deepEqual(requestContext(null, "https://mail.test/", req(nav)), { crossSite: false, topLevel: true });
  assert.deepEqual(requestContext(evil, "https://mail.test/", req(nav)), { crossSite: true, topLevel: false }, "script/iframe navigation");
  assert.deepEqual(requestContext(evil, "https://mail.test/", req({ ...nav, "sec-fetch-user": "?1" })), { crossSite: true, topLevel: true }, "user clicked");
  assert.deepEqual(requestContext(evil, "https://mail.test/", req({ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })), { crossSite: true, topLevel: false });
  assert.equal(requestContext(evil, "https://mail.test/", req({ ...nav, "sec-fetch-user": "?1" }, "POST")).topLevel, false);
});

test("jar summary, clear, and save/load", () => {
  const jar = new CookieJar();
  jar.set("a=1", "https://www.a.test/");
  jar.set("b=1", "https://x.a.test/");
  jar.set("c=1", "https://b.test/");
  assert.deepEqual(jar.summary(), { "a.test": 2, "b.test": 1 });
  const copy = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar)));
  assert.equal(copy.header("https://www.a.test/"), "a=1");
  copy.clear("a.test");
  assert.deepEqual(copy.summary(), { "b.test": 1 });
  copy.clear();
  assert.equal(copy.size, 0);
});

// ---------- sessions ----------

const fakeReq = (headers = {}) => ({ headers, socket: {} });
const fakeRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

test("sessions: a private kite_sid per person, reused, and saved to a file", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kite-")), "cookies.json");
  const sessions = new Sessions({ file });
  const res = fakeRes();
  const jar = sessions.jarFor(fakeReq({ host: "kite.example.com", "x-forwarded-proto": "https" }), res);
  const setCookie = res.headers["set-cookie"];
  assert.match(setCookie, /^kite_sid=[\w-]{32}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=None; Partitioned$/);
  const sid = setCookie.split(";")[0];
  assert.equal(sessions.jarFor(fakeReq({ cookie: sid })), jar, "same person, same jar");
  assert.notEqual(sessions.jarFor(fakeReq(), fakeRes()), jar, "someone else gets their own jar");
  assert.equal(sessions.jarFor(fakeReq()), null, "no session without a response to set it on");
  const plain = fakeRes();
  new Sessions().jarFor(fakeReq({ host: "kite.lan:8080" }), plain);
  assert.match(plain.headers["set-cookie"], /SameSite=Lax$/, "plain http on a LAN name");

  jar.set("login=yes; Max-Age=3600; Path=/", "https://site.test/");
  sessions.save();
  if (process.platform !== "win32") {
    // Windows has no owner-only file mode; there the file is protected by the
    // permissions of the folder it's in (e.g. your user folder).
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600", "file is private");
  }
  const reloaded = new Sessions({ file });
  assert.equal(reloaded.jarFor(fakeReq({ cookie: sid })).header("https://site.test/"), "login=yes");
});

// ---------- through the proxy ----------

let site, siteUrl, seenCookies;
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seenCookies = req.headers.cookie || null;
    if (u.pathname === "/login") {
      res.writeHead(302, { location: "/account", "set-cookie": ["session=abc; HttpOnly; Path=/", "theme=dark; Path=/"] });
      return res.end();
    }
    if (u.pathname === "/account") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(/session=abc/.test(req.headers.cookie || "") ? "<p>hello, signed in</p>" : "<p>please sign in</p>");
    }
    if (u.pathname === "/api/prefs") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "lang=fr; Path=/" });
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "text/plain" });
    if (req.url.includes("__kite_t")) return res.end("LEAKED " + req.url);
    if (u.pathname === "/x" && u.search && u.search !== "?q=1") return res.end("WRONG QUERY " + u.search);
    res.end("cookie=" + (req.headers.cookie || ""));
  });
  siteUrl = await listen(site);
});
after(() => site.close());

function proxyWith(jar) {
  const s = http.createServer((req, res) => handleProxy(req, res, { allowPrivate: true, allowedPorts: null, jar }));
  return listen(s).then((u) => ({ url: u, close: () => s.close() }));
}

test("login: cookies from a redirect are kept and sent on the next hop", async () => {
  const jar = new CookieJar();
  const p = await proxyWith(jar);
  const r = await fetch(p.url + P(siteUrl + "/login"), { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } });
  const html = await r.text();
  assert.ok(html.includes("hello, signed in"), html.slice(0, 200));
  assert.equal(r.headers.get("set-cookie"), null, "site cookies never reach the real browser");
  assert.ok(html.includes(JSON.stringify("theme=dark")), "document.cookie starts with the page's script cookies");
  assert.ok(!html.includes("session=abc"), "HttpOnly cookies are never given to the page");
  p.close();
});

test("same-site requests carry cookies; third-party requests don't", async () => {
  const jar = new CookieJar();
  jar.set("session=abc; Path=/", siteUrl + "/");
  const p = await proxyWith(jar);
  const fromOwnPage = await (await fetch(p.url + P(siteUrl + "/x"), { headers: { referer: p.url + P(siteUrl + "/home") } })).text();
  assert.equal(fromOwnPage, "cookie=session=abc");
  const fromOtherSite = await (await fetch(p.url + P(siteUrl + "/x"), { headers: { referer: p.url + P("https://evil.test/") } })).text();
  assert.equal(fromOtherSite, "cookie=", "another site's page can't borrow your cookies");
  p.close();
});

test("a fetch that sets cookies tells the page's document.cookie", async () => {
  const jar = new CookieJar();
  jar.set("session=abc; HttpOnly; Path=/", siteUrl + "/");
  const p = await proxyWith(jar);
  const r = await fetch(p.url + P(siteUrl + "/api/prefs"), { headers: { referer: p.url + P(siteUrl + "/home") } });
  assert.equal(decodeURIComponent(r.headers.get("x-kite-cookies")), "lang=fr");
  p.close();
});

// ---------- /__kite/ endpoints ----------

test("document.cookie writes: only for the page's own site, never HttpOnly", async () => {
  const sessions = new Sessions();
  const s = http.createServer(async (req, res) => {
    if (!(await handleKiteApi(req, res, { sessions, allowedOrigins: ["https://kite.example"] }))) res.end();
  });
  const u = await listen(s);
  const res0 = fakeRes();
  const jar = sessions.jarFor(fakeReq({ host: "x" }), res0);
  const sid = res0.headers["set-cookie"].split(";")[0];
  const write = (text, headers = {}) =>
    fetch(u + "/__kite/cookie", { method: "POST", body: text, headers: { cookie: sid, "sec-fetch-site": "same-origin", referer: u + P("https://news.test/a/b"), ...headers } });
  assert.equal((await write("consent=yes; path=/")).status, 204);
  assert.equal(jar.header("https://news.test/"), "consent=yes");
  await write("x=1; domain=other.test; path=/");
  assert.equal(jar.header("https://other.test/"), "", "can't set another site's cookie");
  await write("y=1; HttpOnly; path=/");
  assert.equal(jar.header("https://news.test/"), "consent=yes");
  assert.equal((await write("z=1", { "sec-fetch-site": "cross-site" })).status, 403);

  const ui = await fetch(u + "/__kite/cookies", { headers: { cookie: sid, origin: "https://kite.example" } });
  assert.deepEqual(await ui.json(), { sites: { "news.test": 1 } });
  assert.equal(ui.headers.get("access-control-allow-origin"), "https://kite.example");
  const page = await fetch(u + "/__kite/cookies", { headers: { cookie: sid, origin: u } });
  assert.equal(page.status, 403, "pages inside Kite can't read the cookie list");
  const cleared = await fetch(u + "/__kite/cookies/clear", {
    method: "POST", body: "site=news.test", headers: { cookie: sid, origin: "https://kite.example", "content-type": "application/x-www-form-urlencoded" },
  });
  assert.deepEqual(await cleared.json(), { sites: {} });
  s.close();
});

// ---------- the backend's gate ----------

test("a Kite session lets you in even when the browser sends no Referer", async () => {
  const { createKiteServer } = await import("../app.js");
  const { server } = createKiteServer({ allowedOrigins: ["https://kite.example"], allowPrivate: true, allowedPorts: null, log: () => {} });
  const u = await listen(server);
  const page = u + P(siteUrl + "/x");
  const strangers = await fetch(page, { redirect: "manual" });
  assert.equal(strangers.status, 403, "no Referer and no session: refused");
  const first = await fetch(page, { headers: { referer: "https://kite.example/" } });
  assert.equal(first.status, 200, "first load from the Kite UI");
  const sid = first.headers.get("set-cookie").split(";")[0];
  const later = await fetch(page, { headers: { cookie: sid } });
  assert.equal(later.status, 200, "same person, no Referer: allowed");
  const forged = await fetch(page, { headers: { cookie: "kite_sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
  assert.equal(forged.status, 403, "made-up session ids don't count");
  server.close();
});

test("a tab ticket from the Kite UI lets a page in with no Referer and no cookies", async () => {
  const { createKiteServer } = await import("../app.js");
  const { server } = createKiteServer({ allowedOrigins: ["https://kite.example"], allowPrivate: true, allowedPorts: null, log: () => {} });
  const u = await listen(server);
  const notUi = await fetch(u + "/__kite/ticket", { headers: { origin: u } });
  assert.equal(notUi.status, 403, "pages inside Kite can't get tickets");
  const r = await fetch(u + "/__kite/ticket", { headers: { origin: "https://kite.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), "https://kite.example");
  const { ticket } = await r.json();
  assert.match(ticket, /^[\w-]{32}$/);
  const page = (t) => fetch(u + P(siteUrl + "/x?q=1") + (t ? "?__kite_t=" + t : ""));
  const ok = await page(ticket);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "cookie=", "ticket never reaches the site, and the page's own query is kept");
  assert.equal((await page("not-a-real-ticket-at-all-0000000")).status, 403);
  assert.equal((await page(null)).status, 403);
  server.close();
});
