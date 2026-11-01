// Kite Search: words, page reading, robots.txt, ranking, the crawler, the API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { terms, stem, parseQuery } from "../search/text.js";
import { extract } from "../search/extract.js";
import { parseRobots, allowed } from "../search/robots.js";
import { SearchIndex } from "../search/index.js";
import { normalizeUrl } from "../search/crawler.js";
import { SearchEngine } from "../search/engine.js";
import { createKiteServer } from "../app.js";
import { resetLimits } from "../kite-api.js";

test("words: folded, stemmed, stop words dropped", () => {
  assert.deepEqual(terms("The Running Kites of Café-Land!"), ["run", "kite", "cafe", "land"]);
  assert.equal(stem("flies"), "fly");
  assert.equal(stem("boxes"), "box");
  assert.equal(stem("class"), "class");
  assert.equal(stem("stopped"), "stop");
  assert.deepEqual(terms("the a of"), ["the", "a", "of"], "only stop words: kept");
  const q = parseQuery('"red kite" nesting site:Wikipedia.org');
  assert.deepEqual(q.phrases, ["red kite"]);
  assert.equal(q.site, "wikipedia.org");
  assert.deepEqual(q.terms, ["red", "kite", "nest"]);
});

test("reading a page: title, description, text, links, robots meta", () => {
  const p = extract(`<html lang="en"><head><title>Kites &amp; More</title><meta name="description" content="All about kites">
    <link rel="canonical" href="/kites"><script>var secret = 1;</script></head>
    <body><nav>Menu stuff</nav><h1>Flying kites</h1><p>Kites fly in wind.</p>
    <a href="/a#x">A</a> <a href="https://other.test/b" rel="nofollow">B</a> <a href="javascript:void 0">C</a> <a href="mailto:x@y">D</a></body></html>`, "https://site.test/page");
  assert.equal(p.title, "Kites & More");
  assert.equal(p.description, "All about kites");
  assert.deepEqual(p.headings, ["Flying kites"]);
  assert.ok(p.text.includes("Kites fly in wind") && !p.text.includes("secret") && !p.text.includes("Menu stuff"));
  assert.deepEqual(p.links.map((l) => l.url), ["https://site.test/a"]);
  assert.equal(p.canonical, "https://site.test/kites");
  assert.equal(p.lang, "en");
  assert.equal(p.noindex, false);
  assert.equal(extract('<meta name="robots" content="noindex, nofollow"><a href="/x">x</a>', "https://s.test/").noindex, true);
  assert.equal(extract('<meta name="robots" content="noindex, nofollow"><a href="/x">x</a>', "https://s.test/").links.length, 0);
});

test("robots.txt: KiteBot's rules, longest match, Allow, wildcards, delay", () => {
  const r = parseRobots(`User-agent: *\nDisallow: /\n\nUser-agent: KiteBot\nUser-agent: OtherBot\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.php$\nCrawl-delay: 3`);
  assert.equal(r.delay, 3);
  assert.ok(allowed(r, "/"));
  assert.ok(!allowed(r, "/private/x"));
  assert.ok(allowed(r, "/private/ok/1"));
  assert.ok(!allowed(r, "/a/b.php"));
  assert.ok(allowed(r, "/a/b.php?x=1"));
  const all = parseRobots("User-agent: *\nDisallow: /admin\nDisallow:");
  assert.ok(!allowed(all, "/admin/x") && allowed(all, "/home"));
  assert.ok(allowed(parseRobots(""), "/anything"));
});

test("addresses: one per page", () => {
  assert.equal(normalizeUrl("HTTPS://Example.COM:443/a?utm_source=x&b=1#top"), "https://example.com/a?b=1");
  assert.equal(normalizeUrl("https://example.com/photo.JPG"), null);
  assert.equal(normalizeUrl("ftp://example.com/"), null);
  assert.equal(normalizeUrl("/x", "https://e.com/a/b"), "https://e.com/x");
});

test("ranking: title beats text, all words beat some, links count, snippets mark the words", () => {
  const ix = new SearchIndex();
  const add = (url, title, text, links = []) => ix.add({ url, title, description: "", headings: [], text, links });
  add("https://birds.test/red-kite", "Red kite", "The red kite is a bird of prey. Red kites nest in tall trees and eat carrion.");
  add("https://toys.test/kites", "Toy kites for sale", "Buy a red or blue kite today. Our kites fly well.");
  add("https://news.test/weather", "Weather", "Strong wind today, good for kites. Red sky at night.");
  add("https://blog.test/a", "My blog", "I saw a bird. " + "nothing ".repeat(50), [{ url: "https://birds.test/red-kite" }, { url: "https://toys.test/kites" }]);
  add("https://blog2.test/b", "Another blog", "words", [{ url: "https://birds.test/red-kite" }]);
  const r = ix.search("red kite");
  assert.equal(r.results[0].url, "https://birds.test/red-kite");
  assert.equal(r.total, 3);
  assert.ok(r.results.every((x) => x.url !== "https://blog.test/a"), "pages without the words aren't results");
  const hits = r.results[0].snippet.filter((s) => s.hit).map((s) => s.text.trim().toLowerCase());
  assert.ok(hits.some((h) => h.includes("red")) && hits.some((h) => h.includes("kite")), JSON.stringify(r.results[0].snippet));
  assert.equal(ix.search("kites site:toys.test").results.length, 1);
  assert.equal(ix.search('"blue kite"').results[0].url, "https://toys.test/kites");
  assert.equal(ix.search('"green kite"').total, 0);
  assert.equal(ix.search("").total, 0);
  // Replacing a page.
  add("https://toys.test/kites", "Toy shop", "We sell yo-yos now.");
  assert.equal(ix.search("blue site:toys.test").total, 0, "old words gone");
  assert.equal(ix.search("yo yos").results[0].url, "https://toys.test/kites");
  // The same page at another address isn't added twice.
  assert.ok(ix.add({ url: "https://mirror.test/x", title: "Toy shop", text: "We sell yo-yos now." }).duplicateOf);
  assert.deepEqual(ix.suggest("toy"), ["Toy shop"]);
});

test("saving and loading the index", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kite-search-")), "index.ndjson");
  const ix = new SearchIndex({ file });
  ix.add({ url: "https://a.test/", title: "Alpha page", text: "alpha beta gamma", links: [{ url: "https://b.test/" }] });
  ix.saveNow();
  const again = new SearchIndex({ file });
  assert.equal(again.size, 1);
  assert.equal(again.search("gamma").results[0].url, "https://a.test/");
  assert.equal(again.inlinks.get("https://b.test/"), 1);
});

// ---------- the crawler, on a small local site ----------
let site, base, hits;
before(async () => {
  hits = [];
  const pages = {
    "/robots.txt": [200, "text/plain", "User-agent: *\nDisallow: /secret\n"],
    "/": [200, "text/html", `<title>Home of Gliders</title><p>Welcome to the glider club.</p><a href="/about">About</a> <a href="/secret/x">S</a> <a href="/old">Old</a> <a href="/hidden">H</a> <a href="/data.pdf">pdf</a> <a href="/dup?utm_source=a">D</a>`],
    "/about": [200, "text/html; charset=utf-8", `<title>About the club</title><meta name="description" content="Gliders since 1950"><p>We fly sailplanes over the hills.</p><a href="/">Home</a>`],
    "/secret/x": [200, "text/html", "<title>Secret</title>"],
    "/old": [301, "text/html", "", { location: "/new" }],
    "/new": [200, "text/html", `<title>New page</title><p>Thermals and ridge lift.</p>`],
    "/hidden": [200, "text/html", `<title>Hidden</title><meta name="robots" content="noindex"><a href="/via-hidden">x</a>`],
    "/via-hidden": [200, "text/html", `<title>Reached through hidden</title>`],
    "/dup": [200, "text/html", `<title>Dup</title><p>d</p>`],
  };
  site = http.createServer((req, res) => {
    hits.push(req.url);
    const p = pages[req.url];
    if (!p) return res.writeHead(404).end();
    res.writeHead(p[0], { "content-type": p[1], ...(p[3] || {}) });
    res.end(p[2]);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
});
after(() => site.close());

test("the crawler reads a site politely and follows its rules", async () => {
  const engine = new SearchEngine({ seeds: [base + "/"], crawlerOptions: { allowPrivate: true, allowedPorts: null, hostDelayMs: 0, concurrency: 2 } });
  engine.start();
  for (let i = 0; i < 100 && (engine.crawler.queued || engine.crawler.active || !engine.index.size); i++) await new Promise((r) => setTimeout(r, 50));
  engine.stop();
  const urls = [...engine.index.docs.values()].map((d) => d.url).sort();
  assert.deepEqual(urls, [base + "/", base + "/about", base + "/dup", base + "/new", base + "/via-hidden"].sort(), JSON.stringify(engine.crawler.recent));
  assert.ok(!hits.includes("/secret/x"), "robots.txt obeyed");
  assert.ok(!hits.includes("/data.pdf"), "not a page");
  assert.equal(hits.filter((h) => h === "/robots.txt").length, 1, "robots.txt read once");
  assert.equal(engine.search("sailplanes").results[0].url, base + "/about");
  assert.equal(engine.search("ridge lift").results[0].url, base + "/new", "redirect followed, indexed at the final address");
  assert.equal(engine.search("hidden").results.length, 1, "noindex page left out, but its links followed");
  const st = engine.status();
  assert.equal(st.pages, 5);
  assert.ok(st.crawler.recent.some((r) => r.result === "robots.txt says no" || r.result === "noindex"));
});

test("the crawler never reads private addresses unless allowed", async () => {
  const engine = new SearchEngine({ seeds: [], crawlerOptions: {} });
  await assert.rejects(() => engine.crawler.fetch(base + "/"), /not allowed/);
  await assert.rejects(() => engine.crawler.fetch("http://localhost:1/"), /not allowed/);
});

test("the search API: results for the Kite UI and the app, others refused", async () => {
  resetLimits();
  const engine = new SearchEngine({ seeds: [], crawl: false });
  engine.index.add({ url: "https://kites.test/", title: "Kite shop", text: "Stunt kites and parafoils" });
  const k = createKiteServer({ allowedOrigins: ["http://localhost:3000"], log: () => {}, captureConsole: false, search: engine });
  await new Promise((r) => k.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${k.server.address().port}`;
  try {
    const ui = await fetch(url + "/__kite/search?q=parafoil", { headers: { origin: "http://localhost:3000" } });
    assert.equal(ui.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const body = await ui.json();
    assert.equal(body.results[0].url, "https://kites.test/");
    assert.equal(body.pages, 1);
    assert.ok(typeof body.took === "number");
    const app = await (await fetch(url + "/__kite/search?q=stunt")).json(); // the app: no Origin
    assert.equal(app.total, 1);
    assert.equal((await fetch(url + "/__kite/search?q=x", { headers: { origin: "https://evil.test" } })).status, 403);
    assert.deepEqual((await (await fetch(url + "/__kite/search/suggest?q=kit")).json()).suggestions, ["Kite shop"]);
    let last;
    for (let i = 0; i < 60; i++) last = await fetch(url + "/__kite/search?q=x");
    assert.equal(last.status, 429, "rate-limited");
  } finally {
    k.server.closeAllConnections();
    k.server.close();
  }
});
