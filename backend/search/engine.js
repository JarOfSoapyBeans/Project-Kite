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

export class SearchEngine {
  constructor({ file = null, maxPages = 20000, seeds = DEFAULT_SEEDS, crawl = true, learn = false, crawlerOptions = {} } = {}) {
    this.index = new SearchIndex({ file, maxPages });
    this.crawler = new Crawler({ index: this.index, seeds, queueFile: file ? file + ".queue" : null, ...crawlerOptions });
    this.crawl = crawl;
    this.learn = learn;
    this.learned = new Set();
    this.searches = 0;
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

  search(q, opts) {
    this.searches++;
    const started = process.hrtime.bigint();
    const r = this.index.search(q, opts);
    return { ...r, took: Number(process.hrtime.bigint() - started) / 1e6, pages: this.index.size };
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
