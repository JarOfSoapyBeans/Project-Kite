// Stage 5: the JavaScript rewriter and how the proxy uses it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { findRenames, applyEdits, rewriteJs, kiteRenamer } from "../jsrewrite.js";
import { handleProxy, rewriteHtml, toProxyUrl as P } from "../proxy.js";

const rw = (src) => applyEdits(src, findRenames(src));

test("renames real uses of location and top", () => {
  assert.equal(rw("location.href = x"), "__kite$location.href = x");
  assert.equal(rw("if (window.top !== window.self) top.location.reload()"),
    "if (window.__kite$top !== window.self) __kite$top.__kite$location.reload()");
  assert.equal(rw("a?.location; document.location; new URL(location)"), "a?.__kite$location; document.__kite$location; new URL(__kite$location)");
  assert.equal(rw("let left = 0, top = 0; top += 1;"), "let left = 0, __kite$top = 0; __kite$top += 1;");
  assert.equal(rw("function f(location) { return location }"), "function f(__kite$location) { return __kite$location }");
  assert.equal(rw("`${location.host}/x`"), "`${__kite$location.host}/x`");
  assert.equal(rw("a ? location : top"), "a ? __kite$location : __kite$top");
});

test("leaves strings, comments, regexes, keys, labels and class members alone", () => {
  for (const src of [
    `"location" + 'top' + \`top\``,
    "// location\n/* top */ 1",
    "x = /location|top/g.test(s)",
    "o = { location: 1, top: 2, location() {}, get top() {} }",
    "top: for (;;) { break top; }",
    "class A { top = 1; location() {} static top() {} #location = 2; m() { this.#location } }",
    "var t = { 'top': 1 }['top']",
  ]) assert.equal(rw(src), src, src);
});

test("object shorthand keeps its key", () => {
  assert.equal(rw("x = { top, a }"), "x = { top: __kite$top, a }");
  assert.equal(rw("const { location } = window"), "const { location: __kite$location } = window");
  assert.equal(rw("if (a) { top = 1; }"), "if (a) { __kite$top = 1; }", "a block, not an object");
});

test("regex vs division", () => {
  assert.equal(rw("a = b / top / 2"), "a = b / __kite$top / 2");
  assert.equal(rw("if (x) /top/.test(y); top"), "if (x) /top/.test(y); __kite$top");
  assert.equal(rw("x = (a) / top"), "x = (a) / __kite$top");
});

test("a result that doesn't parse falls back to the original", () => {
  const weird = "class A { a = 1\n top = 2 }"; // a class field after ASI looks like an assignment
  const out = rewriteJs(weird);
  assert.doesNotThrow(() => new Function(out));
});

test("the browser copy of the renamer works on its own", () => {
  const r = new Function(`return (${kiteRenamer.toString()})()`)();
  assert.equal(r.applyEdits("top.location", r.findRenames("top.location")), "__kite$top.__kite$location");
});

test("inline scripts and event handlers in HTML are rewritten; data blocks are not", () => {
  const out = rewriteHtml(
    `<head></head><body onclick="location.href='/x'"><a href="javascript:top.location='/y'">a</a>` +
      `<script>if (top !== self) location.reload()</script><script type="application/json">{"top":1}</script>` +
      `<script src="/a.js"></script></body>`,
    "https://a.test/"
  );
  assert.ok(out.includes(`onclick="__kite$location.href='/x'"`));
  assert.ok(out.includes(`javascript:__kite$top.__kite$location='/y'`));
  assert.ok(out.includes("if (__kite$top !== self) __kite$location.reload()"));
  assert.ok(out.includes(`{"top":1}`));
});

// ---------- through the proxy ----------

let site, siteUrl, proxy, proxyUrl, seen;
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));
before(async () => {
  site = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "application/javascript", etag: '"v1"', "cache-control": "max-age=31536000" });
    res.end("window.x = location.pathname + top.length;");
  });
  siteUrl = await listen(site);
  proxy = http.createServer((req, res) => handleProxy(req, res, { allowPrivate: true, allowedPorts: null }));
  proxyUrl = await listen(proxy);
});
after(() => {
  site.close();
  proxy.close();
});

test("scripts the browser runs are rewritten; data fetched as JS isn't", async () => {
  const asScript = await fetch(proxyUrl + P(siteUrl + "/a.js"), { headers: { "sec-fetch-dest": "script", "if-none-match": '"v1"' } });
  assert.equal(await asScript.text(), "window.x = __kite$location.pathname + __kite$top.length;");
  assert.equal(asScript.headers.get("etag"), null, "no validators for rewritten scripts");
  assert.equal(seen["if-none-match"], undefined, "a stale cached copy can't be revalidated");
  const asData = await fetch(proxyUrl + P(siteUrl + "/a.js"), { headers: { "sec-fetch-dest": "empty" } });
  assert.equal(await asData.text(), "window.x = location.pathname + top.length;");
});

test("workers get the worker prelude", async () => {
  const r = await fetch(proxyUrl + P(siteUrl + "/w.js"), { headers: { "sec-fetch-dest": "worker" } });
  const body = await r.text();
  assert.match(body, /^\(function kiteWorkerClient\(\)/);
  assert.ok(body.endsWith("window.x = __kite$location.pathname + __kite$top.length;"));
  assert.doesNotThrow(() => new Function(body));
});

test("a 3 MB script is rewritten quickly, and faster the second time", () => {
  const chunk = "function f(a){var top=a.top,b={location:1};if(window.top!==self)location.href='/x';return /top/.test(a)?top:b.location}\n";
  const big = chunk.repeat(Math.ceil(3e6 / chunk.length)) + `//${Math.random()}`;
  let t = performance.now();
  const out = rewriteJs(big);
  const first = performance.now() - t;
  t = performance.now();
  assert.equal(rewriteJs(big), out);
  const second = performance.now() - t;
  assert.ok(first < 3000, `first rewrite took ${first.toFixed(0)} ms`);
  assert.ok(second < first / 3, `cached rewrite took ${second.toFixed(0)} ms`);
});
