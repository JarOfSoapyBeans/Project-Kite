// Pings, referrer handling, browser-like headers, and the x-kite-source label.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { toProxyUrl as P, rewriteHtml, handleProxy } from "../proxy.js";

test("ping URLs are rewritten; referrer overrides are removed", () => {
  const out = rewriteHtml(
    `<head><meta name="referrer" content="no-referrer"></head><a href="/a" ping="/gen_204 https://log.test/p">x</a><img src="i.png" referrerpolicy="no-referrer">`,
    "https://g.test/search"
  );
  assert.ok(out.includes(`ping="${P("https://g.test/gen_204")} ${P("https://log.test/p")}"`));
  assert.doesNotMatch(out, /name="referrer"/);
  assert.doesNotMatch(out, /referrerpolicy/i);
});

let site, siteUrl, proxy, proxyUrl;
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const pick = ["referer", "origin", "sec-fetch-site", "sec-fetch-dest", "sec-ch-ua"];
    res.end(JSON.stringify(Object.fromEntries(pick.map((h) => [h, req.headers[h] ?? null]))));
  });
  siteUrl = await listen(site);
  proxy = http.createServer((req, res) => handleProxy(req, res, { allowPrivate: true, allowedPorts: null }));
  proxyUrl = await listen(proxy);
});
after(() => {
  site.close();
  proxy.close();
});

const seen = async (path, headers, init = {}) => {
  const r = await fetch(proxyUrl + path, { headers, redirect: "manual", ...init });
  return { r, h: await r.json() };
};

test("tab load: looks like a page typed into the address bar", async () => {
  const { r, h } = await seen(P(siteUrl + "/"), {
    referer: "https://kite.example/", "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe", "sec-ch-ua": '"Chromium";v="130"',
  });
  assert.equal(r.headers.get("x-kite-source"), "upstream");
  assert.deepEqual(h, { referer: null, origin: null, "sec-fetch-site": "none", "sec-fetch-dest": "document", "sec-ch-ua": '"Chromium";v="130"' });
});

test("same-site subresource: real page sent as Referer", async () => {
  const page = siteUrl + "/search?q=1";
  const { h } = await seen(P(siteUrl + "/style.css"), {
    referer: proxyUrl + P(page), "sec-fetch-site": "same-origin", "sec-fetch-dest": "style",
  });
  assert.equal(h.referer, page);
  assert.equal(h["sec-fetch-site"], "same-origin");
  assert.equal(h["sec-fetch-dest"], "style");
});

test("cross-site subresource and POST: only the page's origin is sent", async () => {
  const { h } = await seen(P(siteUrl + "/gen_204"), {
    referer: proxyUrl + P("https://www.google.test/search?q=x"), "sec-fetch-site": "same-origin", origin: proxyUrl,
  }, { method: "POST", body: "" });
  assert.equal(h.referer, "https://www.google.test/");
  assert.equal(h.origin, "https://www.google.test");
  assert.equal(h["sec-fetch-site"], "cross-site");
});

test("Kite's own errors are labelled", async () => {
  const r = await fetch(proxyUrl + "/proxy/garbage");
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("x-kite-source"), "kite");
});

test("the server's error log can see who answered", async () => {
  const seenBy = [];
  const s = http.createServer((req, res) => {
    res.on("finish", () => seenBy.push(res.getHeader("x-kite-source")));
    handleProxy(req, res, { allowPrivate: true, allowedPorts: null });
  });
  const u = await listen(s);
  await (await fetch(u + P(siteUrl + "/"))).text();
  await (await fetch(u + "/proxy/garbage")).text();
  s.close();
  assert.deepEqual(seenBy, ["upstream", "kite"]);
});

test("custom headers from page scripts reach the site; private ones never do", async () => {
  const echo = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.headers));
  });
  const eu = await listen(echo);
  const r = await fetch(proxyUrl + P(eu + "/youtubei/v1/guide"), {
    method: "POST",
    body: '{"context":{}}',
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": "AIzaTest",
      "x-youtube-client-name": "1",
      cookie: "SID=secret",
      "x-forwarded-for": "203.0.113.7",
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      forwarded: "for=203.0.113.7",
    },
  });
  const h = await r.json();
  echo.close();
  assert.equal(h["x-goog-api-key"], "AIzaTest");
  assert.equal(h["x-youtube-client-name"], "1");
  assert.equal(h["content-length"], "14", "POST bodies keep their length (no chunked upload)");
  assert.equal(h["transfer-encoding"], undefined);
  for (const name of ["cookie", "x-forwarded-for", "cf-connecting-ip", "x-real-ip", "forwarded"]) {
    assert.equal(h[name], undefined, name + " must not be forwarded");
  }
});

test("sites with very large response headers (like YouTube) still load", async () => {
  const big = http.createServer((req, res) => {
    const cookies = Array.from({ length: 60 }, (_, i) => `c${i}=${"v".repeat(600)}; Path=/`);
    // ~36 KB of Set-Cookie (Kite keeps those on the server) plus a long policy header.
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": cookies, "x-policy": "p".repeat(6000) });
    res.end("big-ok");
  });
  const bu = await listen(big);
  try {
    const r = await fetch(proxyUrl + P(bu + "/"));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "big-ok");
  } finally {
    big.close();
    big.closeAllConnections();
  }
});
