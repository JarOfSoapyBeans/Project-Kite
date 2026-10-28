// Run with: npm test  (from /backend). Uses a fake local website, no internet needed.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns";
import zlib from "node:zlib";
import {
  encodeUrl, decodeUrl, toProxyUrl, rewriteHtml, rewriteCss, isBlockedAddress, handleProxy,
} from "../proxy.js";

const P = (u) => toProxyUrl(u);

// ---------- pure functions ----------

test("encode/decode round trip, non-http rejected", () => {
  const u = "https://example.com/a?b=1&c=ü";
  assert.equal(decodeUrl(encodeUrl(u)), new URL(u).href);
  assert.equal(decodeUrl(encodeUrl("file:///etc/passwd")), null);
  assert.equal(decodeUrl("img"), null);
  assert.equal(toProxyUrl("https://x.com/p#frag"), "/proxy/" + encodeUrl("https://x.com/p") + "#frag");
});

test("HTML rewriting", () => {
  const base = "https://site.test/dir/page.html";
  const html = `<!doctype html><html><head><base href="/root/"><meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<link rel="stylesheet" href="a.css" integrity="sha-x"><style>body{background:url('bg.png')}</style></head>
<body><a href="other.html?x=1&amp;y=2#h" target="_blank">x</a><a href="#top">t</a><a href="javascript:void(0)">j</a>
<img src="data:image/png;base64,AA" srcset="s1.png 1x, //cdn.test/s2.png 2x"><div style="background:url(d.png)"></div>
<form action="/search"><input name="q"></form><script src="app.js"></script><script>var s = "<a href='nope'>";</script>
<meta http-equiv="refresh" content="5; url=/next"><!-- <a href="comment.html"> --><br/></body></html>`;
  const out = rewriteHtml(html, base);

  assert.match(out, /^<!doctype html><html><head><script data-kite>/);
  assert.doesNotMatch(out, /<base/i);
  assert.doesNotMatch(out, /Content-Security-Policy/i);
  assert.doesNotMatch(out, /integrity/);
  assert.ok(out.includes(`href="${P("https://site.test/root/a.css")}"`));
  assert.ok(out.includes(`url("${P("https://site.test/root/bg.png")}")`));
  assert.ok(out.includes(`href="${P("https://site.test/root/other.html?x=1&y=2#h")}"`), "entities decoded, hash kept");
  assert.doesNotMatch(out, /target="_blank"/);
  assert.ok(out.includes(`href="#top"`) && out.includes(`href="javascript:void(0)"`));
  assert.ok(out.includes(`src="data:image/png;base64,AA"`));
  assert.ok(out.includes(`srcset="${P("https://site.test/root/s1.png")} 1x, ${P("https://cdn.test/s2.png")} 2x"`));
  assert.ok(out.includes(`style="background:url(&quot;${P("https://site.test/root/d.png")}&quot;)"`));
  assert.ok(out.includes(`action="${P("https://site.test/search")}"`));
  assert.ok(out.includes(`src="${P("https://site.test/root/app.js")}"`));
  assert.ok(out.includes(`var s = "<a href='nope'>";`), "script contents untouched");
  assert.ok(out.includes(`content="5; url=${P("https://site.test/next")}"`));
  assert.ok(out.includes(`<!-- <a href="comment.html"> -->`));
  assert.ok(out.includes("<br />"));
});

test("injected script goes after doctype when there is no <head>", () => {
  assert.match(rewriteHtml("<!DOCTYPE html><p>hi", "https://a.test/"), /^<!DOCTYPE html><script data-kite>/);
  assert.match(rewriteHtml("<p>hi", "https://a.test/"), /^<script data-kite>/);
});

test("CSS rewriting", () => {
  const out = rewriteCss(`@import "x.css"; @import url(y.css); a{b:url( "z.png" )} c{d:url(data:image/gif;base64,R0)}`, "https://c.test/s/main.css");
  assert.ok(out.includes(`@import "${P("https://c.test/s/x.css")}"`));
  assert.ok(out.includes(`@import url("${P("https://c.test/s/y.css")}")`));
  assert.ok(out.includes(`url("${P("https://c.test/s/z.png")}")`));
  assert.ok(out.includes(`url("data:image/gif;base64,R0")`));
});

test("blocked addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

// ---------- full proxy against a fake website ----------

let site, siteUrl, proxy, proxyUrl, strict, strictUrl;

function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}

before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/page.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'",
        "x-frame-options": "DENY",
        "set-cookie": "a=b",
        "strict-transport-security": "max-age=1",
      });
      return res.end(`<html><head><title>T</title><link rel=stylesheet href="s.css"></head><body><img src="/i.png"></body></html>`);
    }
    if (u.pathname === "/s.css") {
      res.writeHead(200, { "content-type": "text/css" });
      return res.end("body{background:url(bg.png)}");
    }
    if (u.pathname === "/i.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
    }
    if (u.pathname === "/gz.html") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      return res.end(zlib.gzipSync(`<a href="x">gz</a>`));
    }
    if (u.pathname === "/latin1.html") {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      return res.end(Buffer.from("<p>caf\xe9</p>", "latin1"));
    }
    if (u.pathname === "/redir") {
      res.writeHead(302, { location: "/page.html" });
      return res.end();
    }
    if (u.pathname === "/search") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("q=" + u.searchParams.get("q") + " ua=" + req.headers["user-agent"] + " cookie=" + (req.headers.cookie || "none"));
    }
    if (u.pathname === "/echo" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("got " + body);
      });
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<h1>nope</h1>");
  });
  siteUrl = await listen(site);
  proxy = http.createServer((req, res) => handleProxy(req, res, { allowPrivate: true, allowedPorts: null }));
  proxyUrl = await listen(proxy);
  strict = http.createServer((req, res) => handleProxy(req, res, { allowedPorts: null }));
  strictUrl = await listen(strict);
});

after(() => {
  site.close();
  proxy.close();
  strict.close();
});

const get = (base, path, init = {}) => fetch(base + path, { redirect: "manual", ...init });

test("proxies and rewrites an HTML page, strips blocking headers", async () => {
  const r = await get(proxyUrl, P(siteUrl + "/page.html"));
  assert.equal(r.status, 200);
  for (const h of ["content-security-policy", "x-frame-options", "set-cookie", "strict-transport-security"]) {
    assert.equal(r.headers.get(h), null, h);
  }
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await r.text();
  assert.ok(body.includes(`href="${P(siteUrl + "/s.css")}"`));
  assert.ok(body.includes(`src="${P(siteUrl + "/i.png")}"`));
  assert.ok(body.includes("<script data-kite>"));
});

test("rewrites CSS and passes images through byte-for-byte", async () => {
  const css = await (await get(proxyUrl, P(siteUrl + "/s.css"))).text();
  assert.equal(css, `body{background:url("${P(siteUrl + "/bg.png")}")}`);
  const img = Buffer.from(await (await get(proxyUrl, P(siteUrl + "/i.png"))).arrayBuffer());
  assert.deepEqual([...img], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
});

test("gzip and non-UTF-8 pages are decoded", async () => {
  const gz = await get(proxyUrl, P(siteUrl + "/gz.html"));
  assert.equal(gz.headers.get("content-encoding"), null);
  assert.ok((await gz.text()).includes(`href="${P(siteUrl + "/x")}"`));
  assert.ok((await (await get(proxyUrl, P(siteUrl + "/latin1.html"))).text()).includes("café"));
});

test("redirects are rewritten to proxy URLs", async () => {
  const r = await get(proxyUrl, P(siteUrl + "/redir"));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), P(siteUrl + "/page.html"));
});

test("GET form query is applied; cookies are not forwarded", async () => {
  const r = await get(proxyUrl, P(siteUrl + "/search") + "?q=kite+test", { headers: { "user-agent": "KiteTest", cookie: "secret=1" } });
  assert.equal(await r.text(), "q=kite test ua=KiteTest cookie=none");
});

test("POST bodies are forwarded", async () => {
  const r = await get(proxyUrl, P(siteUrl + "/echo"), { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(await r.text(), "got a=1");
});

test("relative URL we missed is recovered from the Referer", async () => {
  const r = await get(proxyUrl, "/proxy/img/a.png?v=2", { headers: { referer: proxyUrl + P(siteUrl + "/dir/page.html") } });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get("location"), P(siteUrl + "/dir/img/a.png?v=2"));
  assert.equal((await get(proxyUrl, "/proxy/garbage")).status, 400);
});

test("upstream 404 status is preserved", async () => {
  const r = await get(proxyUrl, P(siteUrl + "/missing"));
  assert.equal(r.status, 404);
  assert.ok((await r.text()).includes("<h1>nope</h1>"));
});

test("SSRF: private, local and non-http targets are refused", async () => {
  const port = new URL(siteUrl).port;
  for (const target of [
    siteUrl + "/page.html",
    `http://localhost:${port}/page.html`,
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    `http://[::1]:${port}/`,
    `http://[::ffff:127.0.0.1]:${port}/`,
    `http://0x7f.1:${port}/`,
  ]) {
    const r = await get(strictUrl, "/proxy/" + encodeUrl(target));
    assert.equal(r.status, 403, target);
  }
  assert.equal((await get(strictUrl, "/proxy/" + encodeUrl("file:///etc/passwd"))).status, 400);
});

test("SSRF: a hostname that resolves to a private IP is refused at connect time", async () => {
  const real = dns.lookup;
  const m = mock.method(dns, "lookup", (host, opts, cb) => {
    if (host !== "evil.test") return real(host, opts, cb);
    return opts && opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  });
  try {
    const port = new URL(siteUrl).port;
    const r = await get(strictUrl, "/proxy/" + encodeUrl(`http://evil.test:${port}/page.html`));
    assert.equal(r.status, 403);
    assert.ok((await r.text()).includes("private or local"));
  } finally {
    m.mock.restore();
  }
});

test("default port allow-list blocks odd ports", async () => {
  const s = http.createServer((req, res) => handleProxy(req, res, {}));
  const u = await listen(s);
  const r = await get(u, "/proxy/" + encodeUrl("http://example.com:6379/"));
  s.close();
  assert.equal(r.status, 403);
});
