// Kite Search: the crawler ("KiteBot"). Starts from a few seed sites, reads
// pages, adds them to the index and follows their links, politely:
//   - obeys robots.txt (and its Crawl-delay), and pages' noindex / nofollow
//   - one request at a time per site, at least 1.5 s apart
//   - a few sites at once (4 by default), a page limit per site
//   - only public addresses (the same check the proxy uses), only HTML,
//     at most 2 MB a page, no cookies, never signed in to anything
// What it still has to read (the queue) is saved next to the index, so a
// restart carries on where it stopped. Pages are read again after a week.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import { checkTarget, guardedLookup } from "../proxy.js";
import { extract } from "./extract.js";
import { parseRobots, allowed, BOT_NAME } from "./robots.js";
import { hostOf } from "./index.js";
import { terms } from "./text.js";

export const USER_AGENT = `Mozilla/5.0 (compatible; ${BOT_NAME}/1.0; +https://github.com/JarOfSoapyBeans/Project-Kite)`;
export const DEFAULT_SEEDS = [
  "https://en.wikipedia.org/wiki/Main_Page",
  "https://developer.mozilla.org/en-US/",
  "https://www.bbc.com/news",
  "https://www.gutenberg.org/",
  "https://news.ycombinator.com/",
  "https://www.nasa.gov/",
  "https://www.python.org/",
  "https://nodejs.org/en",
];
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_QUEUE = 200_000;
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref_src|igshid|_ga)$/i;

// One address per page: no #fragment, no tracking parameters, default ports dropped.
export function normalizeUrl(input, base) {
  try {
    const u = new URL(input, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.username = "";
    u.password = "";
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    // Addresses that are almost never pages worth searching.
    if (/\.(jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|pdf|zip|gz|tgz|rar|7z|exe|msi|dmg|apk|mp[34]|m4[av]|webm|ogg|wav|flac|avi|mov|mkv|woff2?|ttf|eot|iso|bin)$/i.test(u.pathname)) return null;
    if (u.href.length > 1000) return null;
    return u.href;
  } catch {
    return null;
  }
}

export class Crawler {
  constructor({ index, seeds = DEFAULT_SEEDS, queueFile = null, concurrency = 4, hostDelayMs = 1500, maxPerHost = 1000, maxDepth = 6, recrawlDays = 7, allowPrivate = false, allowedPorts = [80, 443, 8080, 8443], log = console.log } = {}) {
    Object.assign(this, { index, seeds, queueFile, concurrency, hostDelayMs, maxPerHost, maxDepth, recrawlDays, allowPrivate, allowedPorts, log });
    this.queues = new Map(); // host -> [{ url, depth, urgent?, hops? }]
    this.urgentHosts = new Set(); // sites with pages waiting for a search
    this.topics = []; // [{ terms, until }]: what searches are waiting for
    this.queued = 0;
    this.seen = new Set(); // addresses queued or read since starting
    this.hosts = new Map(); // host -> { ready, robots, robotsAt, pages }
    this.active = 0;
    this.running = false;
    this.paused = false;
    this.timer = null;
    this.stats = { crawled: 0, indexed: 0, failed: 0, skipped: 0, started: Date.now() };
    this.recent = []; // the last pages read, for Kite DevTools
    for (const d of index.docs.values()) this.#host(d.host).pages++; // the per-site limit counts what's indexed
    this.loadQueue();
  }

  // ---------- the queue ----------

  // force: read it even if it was read recently. urgent: read it before
  // everything else (pages for a search that's waiting); hops: how many more
  // links about the search to follow from it.
  add(url, depth = 0, { force = false, urgent = false, hops = 0 } = {}) {
    const u = normalizeUrl(url);
    if (!u || (!force && this.seen.has(u))) return false;
    if (this.queued >= MAX_QUEUE) return false;
    // Already in the index and read recently: nothing to do.
    const doc = this.index.get(u);
    if (doc && !force && Date.now() - doc.crawled < this.recrawlDays * 86_400_000) return false;
    const host = hostOf(u);
    const h = this.#host(host);
    if (!doc && h.pages >= this.maxPerHost) return false;
    this.seen.add(u);
    if (this.seen.size > 2_000_000) this.seen.clear();
    let q = this.queues.get(host);
    if (!q) this.queues.set(host, (q = []));
    const item = { url: u, depth, ...(urgent ? { urgent: true, hops } : {}) };
    if (urgent) {
      // After the other urgent ones on this site, before the rest.
      let i = 0;
      while (i < q.length && q[i].urgent) i++;
      q.splice(i, 0, item);
      this.urgentHosts.add(host);
    } else if (force) q.unshift(item);
    else q.push(item);
    this.queued++;
    if (!doc) h.pages++;
    return true;
  }

  #host(host) {
    let h = this.hosts.get(host);
    if (!h) this.hosts.set(host, (h = { ready: 0, robots: null, robotsAt: 0, pages: 0 }));
    return h;
  }

  loadQueue() {
    if (!this.queueFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.queueFile, "utf8"));
      for (const [url, depth] of saved.queue || []) this.add(url, depth);
    } catch {}
  }

  saveQueue() {
    if (!this.queueFile) return;
    const list = [];
    for (const q of this.queues.values()) for (const item of q) if (list.length < 50_000) list.push([item.url, item.depth]);
    try {
      fs.writeFileSync(this.queueFile + ".tmp", JSON.stringify({ queue: list }));
      fs.renameSync(this.queueFile + ".tmp", this.queueFile);
    } catch {}
  }

  // ---------- running ----------

  start() {
    if (this.running) return;
    this.running = true;
    if (!this.queued) for (const s of this.seeds) this.add(s, 0, { force: true });
    this.timer = setInterval(() => this.#tick(), 250);
    if (this.timer.unref) this.timer.unref();
    this.#tick();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  pause(on = true) {
    this.paused = on;
  }

  // Searches waiting for pages about them: KiteBot follows links about these.
  addTopic(topicTerms, ms = 10 * 60_000) {
    const list = [...new Set(topicTerms)].filter(Boolean);
    if (!list.length) return;
    const now = Date.now();
    this.topics = this.topics.filter((t) => t.until > now && t.terms.join() !== list.join()).slice(-20);
    this.topics.push({ terms: list, until: now + ms });
  }

  // Is this link about one of the waiting searches? (half its words, at least one)
  #onTopic(link) {
    if (!this.topics.length) return false;
    const now = Date.now();
    let path = "";
    try {
      path = decodeURIComponent(new URL(link.url).pathname).replace(/[-_/.]+/g, " ");
    } catch {}
    const have = new Set(terms(link.text + " " + path));
    return this.topics.some((t) => t.until > now && t.terms.filter((w) => have.has(w)).length >= Math.max(1, Math.ceil(t.terms.length / 2)));
  }

  #tick() {
    if (!this.running || this.paused) return;
    const now = Date.now();
    // Pages a search is waiting for go first, with two extra places.
    for (const host of [...this.urgentHosts]) {
      const q = this.queues.get(host);
      if (!q || !q.length || !q[0].urgent) {
        this.urgentHosts.delete(host);
        continue;
      }
      if (this.active >= this.concurrency + 2) break;
      this.#start(host, q, now);
    }
    for (const [host, q] of this.queues) {
      if (this.active >= this.concurrency) return;
      if (!q.length) {
        this.queues.delete(host);
        continue;
      }
      if (!this.#start(host, q, now)) continue;
      // Round-robin: next time start from the site after this one.
      this.queues.delete(host);
      if (q.length) this.queues.set(host, q);
    }
    // Nothing left to read: read again the pages that are oldest.
    if (!this.queued && !this.active) this.#recrawl();
  }

  // Read the next page of one site, if the site is ready. Returns false if not.
  #start(host, q, now) {
    const h = this.#host(host);
    if (h.ready > now || h.busy || !q.length) return false;
    const item = q.shift();
    this.queued--;
    h.busy = true;
    this.active++;
    this.crawl(item)
      .catch(() => {})
      .finally(() => {
        h.busy = false;
        h.ready = Date.now() + Math.max(this.hostDelayMs, (h.robots && h.robots.delay ? h.robots.delay * 1000 : 0));
        this.active--;
      });
    return true;
  }

  #recrawl() {
    if (Date.now() - (this.lastRecrawl || 0) < 60_000) return; // at most once a minute
    this.lastRecrawl = Date.now();
    const old = Date.now() - this.recrawlDays * 86_400_000;
    const due = [...this.index.docs.values()].filter((d) => d.crawled < old).sort((a, b) => a.crawled - b.crawled).slice(0, 100);
    for (const d of due) this.add(d.url, 1, { force: true });
  }

  // ---------- reading one page ----------

  async robotsFor(origin) {
    const h = this.#host(hostOf(origin));
    if (h.robots && Date.now() - h.robotsAt < 24 * 3600_000) return h.robots;
    let robots = { rules: [], delay: null };
    try {
      const r = await this.fetch(new URL("/robots.txt", origin).href, { maxBytes: 512 * 1024, accept: "text/plain" });
      if (r.status >= 500) robots = { rules: [{ allow: false, path: "/" }], delay: null }; // the site is struggling: stay away for now
      else if (r.status === 200) robots = parseRobots(r.body.toString("utf8"));
    } catch {
      robots = { rules: [{ allow: false, path: "/" }], delay: null };
    }
    h.robots = robots;
    h.robotsAt = Date.now();
    return robots;
  }

  async crawl({ url, depth, urgent = false, hops = 0 }) {
    const urgentHops = urgent ? hops : 0;
    const started = Date.now();
    const note = (result, extra = {}) => {
      this.recent.push({ url, result, time: Date.now(), ms: Date.now() - started, ...extra });
      if (this.recent.length > 100) this.recent.shift();
    };
    let current = url;
    let r;
    for (let hop = 0; ; hop++) {
      const u = new URL(current);
      const robots = await this.robotsFor(u.origin);
      if (!allowed(robots, u.pathname + u.search)) {
        this.stats.skipped++;
        return note("robots.txt says no");
      }
      try {
        r = await this.fetch(current);
      } catch (err) {
        this.stats.failed++;
        return note("failed", { error: err.message });
      }
      if (r.status >= 300 && r.status < 400 && r.location && hop < 5) {
        const next = normalizeUrl(r.location, current);
        if (!next) return note("redirect to something else");
        // Another site: queue it there (its own robots.txt and pace).
        if (hostOf(next) !== hostOf(current)) {
          this.add(next, depth, urgent ? { urgent, hops, force: true } : {});
          return note("redirect", { to: next });
        }
        current = next;
        continue;
      }
      break;
    }
    this.stats.crawled++;
    if (r.status !== 200) {
      if (r.status === 404 || r.status === 410) this.index.remove(url);
      this.stats.failed++;
      return note(`HTTP ${r.status}`);
    }
    if (!/^(text\/html|application\/xhtml\+xml)/i.test(r.type)) {
      this.stats.skipped++;
      return note("not a web page", { type: r.type });
    }
    const page = extract(decode(r.body, r.type), current);
    const tag = String(r.robotsTag || "").toLowerCase();
    const follow = () => {
      if (page.nofollow || /nofollow|none/.test(tag)) return;
      for (const l of page.links) {
        // Links about a waiting search, from a page read for it: read them next.
        if (urgentHops > 0 && this.#onTopic(l)) this.add(l.url, depth + 1, { urgent: true, hops: urgentHops - 1 });
        else if (depth < this.maxDepth) this.add(l.url, depth + 1);
      }
    };
    // "noindex": not in the results, but its links may still be followed.
    if (page.noindex || /noindex|none/.test(tag)) {
      this.index.remove(current);
      this.stats.skipped++;
      follow();
      return note("noindex");
    }
    // The page's own preferred address, if it's on the same site.
    let address = current;
    const canonical = page.canonical && normalizeUrl(page.canonical);
    if (canonical && hostOf(canonical) === hostOf(current)) address = canonical;
    if (address !== url) this.seen.add(address);
    const added = this.index.add({ ...page, url: address, crawled: Date.now() });
    if (added.id) this.stats.indexed++;
    note(added.id ? "indexed" : added.full ? "index full" : "same as another page", { title: page.title, links: page.links.length });
    follow();
  }

  // GET a public address, without cookies. Resolves { status, type, location, body, robotsTag }.
  fetch(url, { maxBytes = MAX_BYTES, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      try {
        checkTarget(u, { allowPrivate: this.allowPrivate, allowedPorts: this.allowedPorts });
      } catch (err) {
        return reject(err);
      }
      const req = (u.protocol === "https:" ? https : http).request(
        {
          protocol: u.protocol,
          hostname: u.hostname.replace(/^\[|\]$/g, ""),
          port: u.port || undefined,
          path: u.pathname + u.search,
          method: "GET",
          headers: { "user-agent": USER_AGENT, accept, "accept-language": "en;q=1.0, *;q=0.5", "accept-encoding": "gzip, deflate, br" },
          lookup: guardedLookup(this.allowPrivate),
        },
        (res) => {
          const status = res.statusCode;
          const type = String(res.headers["content-type"] || "");
          const base = { status, type, location: res.headers.location || null, robotsTag: res.headers["x-robots-tag"] || "" };
          if (status !== 200) {
            res.resume();
            return resolve({ ...base, body: Buffer.alloc(0) });
          }
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          const stream = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
          const chunks = [];
          let size = 0;
          stream.on("data", (c) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy();
              stream.destroy();
              resolve({ ...base, body: Buffer.concat(chunks) }); // the first 2 MB is plenty
              return;
            }
            chunks.push(c);
          });
          stream.on("end", () => resolve({ ...base, body: Buffer.concat(chunks) }));
          stream.on("error", reject);
        }
      );
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  status() {
    return {
      running: this.running,
      paused: this.paused,
      queued: this.queued,
      sitesQueued: this.queues.size,
      active: this.active,
      ...this.stats,
      recent: this.recent.slice(-30).reverse(),
    };
  }
}

// Bytes to text, in the page's own character set when it says one.
function decode(buf, type) {
  let charset = (/charset=([\w-]+)/i.exec(type) || [])[1];
  if (!charset) charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString("latin1")) || [])[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}
