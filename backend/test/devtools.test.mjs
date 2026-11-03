// Kite DevTools (backend side): access, recorded requests and log, live switches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createKiteServer } from "../app.js";
import { resetLimits } from "../kite-api.js";
import { DevtoolsHub, setSettings } from "../devtools.js";
import { toProxyUrl as P } from "../proxy.js";

const UI = "http://localhost:3000";
let site, siteUrl, k, url, hub;
before(async () => {
  process.env.KITE_DEVTOOLS_USERS = "dev, Boss@Example.com";
  site = http.createServer((req, res) => {
    if (req.url === "/a.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end("window.x = location.href;");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head></head><body>hi</body></html>");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  resetLimits();
  hub = new DevtoolsHub();
  k = createKiteServer({ allowedOrigins: [UI], allowPrivate: true, allowedPorts: null, log: () => {}, devtools: hub, captureConsole: false });
  await new Promise((r) => k.server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${k.server.address().port}`;
});
after(() => {
  setSettings({ jsRewrite: true, mediaLog: false, clientOff: [] });
  k.server.closeAllConnections();
  k.server.close();
  site.close();
  delete process.env.KITE_DEVTOOLS_USERS;
});
function browser() {
  let sid = "";
  return async (method, p, body, origin = UI) => {
    const r = await fetch(url + p, { method, headers: { origin, cookie: sid, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get("set-cookie");
    if (set) sid = set.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test("only Kite accounts in KITE_DEVTOOLS_USERS can open Kite DevTools", async () => {
  const guest = browser();
  assert.deepEqual((await guest("GET", "/__kite/devtools/check")).body, { allowed: false, user: null, configured: true });
  assert.equal((await guest("GET", "/__kite/devtools/events")).status, 403);
  const other = browser();
  await other("POST", "/__kite/account/signup", { username: "someone", password: "password123" });
  assert.equal((await other("GET", "/__kite/devtools/events")).status, 403);
  const dev = browser();
  await dev("POST", "/__kite/account/signup", { username: "dev", password: "password123" });
  assert.equal((await dev("GET", "/__kite/devtools/check")).body.allowed, true);
  assert.equal((await dev("GET", "/__kite/devtools/events", undefined, "https://evil.example")).status, 403, "only from the Kite UI");
});

test("requests are recorded with their real address, status, size and time", async () => {
  const dev = browser();
  await dev("POST", "/__kite/account/signin", { username: "dev", password: "password123" });
  const before = (await dev("GET", "/__kite/devtools/events")).body.next;
  await (await fetch(url + P(siteUrl + "/page?x=1"), { headers: { "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" } })).text();
  const { events, next } = (await dev("GET", "/__kite/devtools/events?since=" + before)).body;
  const r = events.find((e) => e.type === "request");
  assert.equal(r.url, siteUrl + "/page?x=1");
  assert.equal(r.status, 200);
  assert.equal(r.source, "upstream");
  assert.equal(r.contentType, "text/html");
  assert.equal(r.dest, "document");
  assert.ok(r.bytes > 1000, "the page with Kite's script");
  assert.ok(next > before);
  assert.deepEqual((await dev("GET", "/__kite/devtools/events?since=" + next)).body.events, [], "nothing new");
});

test("live switches: page-script parts, script rewriting, video log", async () => {
  const dev = browser();
  await dev("POST", "/__kite/account/signin", { username: "dev", password: "password123" });
  const s = (await dev("POST", "/__kite/devtools/settings", { clientOff: ["parent", "nonsense"], jsRewrite: false, mediaLog: true })).body;
  assert.deepEqual(s, { jsRewrite: false, mediaLog: true, youtubeEmbed: true, clientOff: ["parent"] });
  const page = await (await fetch(url + P(siteUrl + "/"), { headers: { "sec-fetch-site": "same-origin" } })).text();
  assert.ok(page.includes(',null,{"parent":true});</script>'), "the page script gets the switches, no renamer");
  const js = await (await fetch(url + P(siteUrl + "/a.js"), { headers: { "sec-fetch-dest": "script", "sec-fetch-site": "same-origin" } })).text();
  assert.equal(js, "window.x = location.href;", "scripts no longer rewritten");
  const back = (await dev("POST", "/__kite/devtools/settings", { clientOff: [], jsRewrite: true, mediaLog: false })).body;
  assert.deepEqual(back, { jsRewrite: true, mediaLog: false, youtubeEmbed: true, clientOff: [] });
  const js2 = await (await fetch(url + P(siteUrl + "/a.js"), { headers: { "sec-fetch-dest": "script", "sec-fetch-site": "same-origin" } })).text();
  assert.equal(js2, "window.x = __kite$location.href;");
  const st = (await dev("GET", "/__kite/devtools/status")).body;
  assert.ok(st.uptime >= 0 && st.memory.rss > 0 && st.parts.parent);
});

test("the log captures what the backend prints", async () => {
  const { captureConsole } = await import("../devtools.js");
  const h = new DevtoolsHub();
  const original = console.log;
  console.log = () => {}; // keep the test output clean
  captureConsole(h);
  console.log("[kite 404] /s/player/base.js");
  console.log = original;
  assert.ok(h.events.some((e) => e.type === "log" && e.text === "[kite 404] /s/player/base.js"));
});
