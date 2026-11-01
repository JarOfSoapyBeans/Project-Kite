// Kite Search: the index and the crawler together, set up from the backend's
// settings (environment variables, see start_home.bat):
//   KITE_SEARCH=0              no Kite Search at all
//   KITE_SEARCH_CRAWL=0        keep the index, but don't crawl (search still works)
//   KITE_SEARCH_FILE           where the index is saved (default: next to the cookies)
//   KITE_SEARCH_MAX_PAGES      how many pages to keep (default 20000)
//   KITE_SEARCH_SEEDS          sites to start from, comma-separated
//   KITE_SEARCH_LEARN=1        also crawl the home pages of sites people open
//                              through Kite (only the site's front page, read
//                              by KiteBot without anyone's cookies)

import path from "node:path";
import { SearchIndex } from "./index.js";
import { Crawler, DEFAULT_SEEDS, normalizeUrl } from "./crawler.js";
import { topicUrls } from "./discover.js";
import { parseQuery } from "./text.js";

export class SearchEngine {
  constructor({ file = null, maxPages = 20000, seeds = DEFAULT_SEEDS, crawl = true, learn = false, crawlerOptions = {}, findTopicUrls = topicUrls } = {}) {
    this.findTopicUrls = findTopicUrls; // (tests use their own)
    this.index = new SearchIndex({ file, maxPages });
    this.crawler = new Crawler({ index: this.index, seeds, queueFile: file ? file + ".queue" : null, ...crawlerOptions });
    this.crawl = crawl;
    this.learn = learn;
    this.learned = new Set();
    this.searches = 0;
    this.discovered = new Map(); // search -> when KiteBot went looking for it
    this.discoveries = []; // times, for the limit
    this.saveTimer = null;
  }

  start() {
    if (this.crawl) this.crawler.start();
    // Save every 2 minutes when something changed.
    this.saveTimer = setInterval(() => {
      this.index.save();
      this.crawler.saveQueue();
    }, 120_000);
    if (this.saveTimer.unref) this.saveTimer.unref();
    let last = this.index.size;
    this.reportTimer = setInterval(() => {
      if (this.index.size !== last) console.log(`[search] ${this.index.size} pages in Kite Search (+${this.index.size - last} in 10 min), ${this.crawler.queued} waiting to be read`);
      last = this.index.size;
    }, 600_000);
    if (this.reportTimer.unref) this.reportTimer.unref();
  }

  stop() {
    this.crawler.stop();
    clearInterval(this.saveTimer);
    clearInterval(this.reportTimer);
  }

  saveNow() {
    try {
      this.index.saveNow();
      this.crawler.saveQueue();
    } catch (err) {
      console.log(`[search] couldn't save: ${err.message}`);
    }
  }

  search(q, opts = {}) {
    this.searches++;
    const started = process.hrtime.bigint();
    const r = this.index.search(q, opts);
    const took = Number(process.hrtime.bigint() - started) / 1e6;
    // Little or nothing about the whole search: KiteBot goes to find pages about it.
    const discovering = (opts.page || 1) === 1 && r.complete < 3 ? this.discover(q) : false;
    return { ...r, took, pages: this.index.size, discovering };
  }

  // Send KiteBot to pages likely to be about this search (search/discover.js),
  // and have it follow their links about it. At most once per search per half
  // hour, and 20 searches a minute in all. Returns true while it's looking.
  discover(q) {
    if (!this.crawl || !this.crawler.running) return false;
    const key = String(q).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
    const now = Date.now();
    const last = this.discovered.get(key);
    if (last && now - last < 30 * 60_000) return now - last < 60_000; // still looking for the first minute
    this.discoveries = this.discoveries.filter((t) => now - t < 60_000);
    if (this.discoveries.length >= 20) return false;
    const query = parseQuery(q);
    if (!query.terms.length) return false;
    const urls = this.findTopicUrls(q);
    let added = 0;
    for (const u of urls) if (this.crawler.add(u, 1, { force: true, urgent: true, hops: 2 })) added++;
    this.crawler.addTopic(query.terms);
    this.discoveries.push(now);
    this.discovered.set(key, now);
    if (this.discovered.size > 5000) this.discovered.delete(this.discovered.keys().next().value);
    console.log(`[search] looking for pages about "${key}" (${added} to read first)`);
    return true;
  }

  // Someone opened a page through Kite: maybe read that site's home page.
  noteVisit(url) {
    if (!this.learn || !this.crawl) return;
    try {
      const home = normalizeUrl(new URL(url).origin + "/");
      if (!home || this.learned.has(home)) return;
      this.learned.add(home);
      if (this.learned.size > 100_000) this.learned.clear();
      this.crawler.add(home, 1);
    } catch {}
  }

  status() {
    return { ...this.index.stats(), searches: this.searches, crawling: this.crawl, learn: this.learn, crawler: this.crawler.status() };
  }
}

export function searchFromEnv(env = process.env) {
  if (env.KITE_SEARCH === "0") return null;
  const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const file = env.KITE_SEARCH_FILE || (env.COOKIE_FILE ? path.join(path.dirname(env.COOKIE_FILE), ".kite-search.ndjson") : null);
  const seeds = list(env.KITE_SEARCH_SEEDS);
  return new SearchEngine({
    file,
    maxPages: Number(env.KITE_SEARCH_MAX_PAGES) || 20000,
    seeds: seeds.length ? seeds : DEFAULT_SEEDS,
    crawl: env.KITE_SEARCH_CRAWL !== "0",
    learn: env.KITE_SEARCH_LEARN === "1",
  });
}
