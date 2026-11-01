// Kite Search: the index. An inverted index (word -> the pages that have it,
// with a weight) kept in memory and saved to a file, ranked with BM25 (the
// classic search-engine formula: rare words count more, a word's tenth mention
// counts less than its first, long pages don't win just by being long) plus:
//   - where the word is: title > address > headings > description > text
//   - pages that have all your words beat pages with some of them
//   - pages other sites link to rank higher (a light PageRank)
//   - "exact phrases" and site:example.com narrow the results
// No dependencies.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { terms, urlTerms, words, fold, parseQuery, stem } from "./text.js";

const WEIGHTS = { title: 4, url: 2.5, heading: 2, description: 1.5, text: 1 };
const MAX_TERMS_PER_PAGE = 250; // the page's strongest words are indexed
const SNIPPET_TEXT = 4000; // characters kept per page for snippets
const K1 = 1.2;
const B = 0.75;

export class SearchIndex {
  constructor({ file = null, maxPages = 20000 } = {}) {
    this.file = file;
    this.maxPages = maxPages;
    this.docs = new Map(); // id -> doc
    this.byUrl = new Map(); // url -> id
    this.hashes = new Map(); // text hash -> id (the same page under two addresses)
    this.postings = new Map(); // term -> [id, weight, id, weight, ...]
    this.inlinks = new Map(); // url -> pages on other sites linking to it
    this.nextId = 1;
    this.totalLength = 0;
    this.dead = 0; // postings of replaced pages, cleaned up by #compact
    this.dirty = false;
    if (file) this.load();
  }

  get size() {
    return this.docs.size;
  }

  has(url) {
    return this.byUrl.has(url);
  }

  get(url) {
    const id = this.byUrl.get(url);
    return id ? this.docs.get(id) : null;
  }

  // Add or replace a page. page: { url, title, description, headings, text, links, lang }.
  add(page) {
    const text = String(page.text || "");
    const hash = crypto.createHash("sha1").update(fold(page.title) + "\n" + fold(text).slice(0, 20000)).digest("base64").slice(0, 16);
    const same = this.hashes.get(hash);
    if (same && this.docs.get(same) && this.docs.get(same).url !== page.url) return { duplicateOf: this.docs.get(same).url };
    const old = this.byUrl.get(page.url);
    if (!old && this.docs.size >= this.maxPages) return { full: true };
    if (old) this.remove(page.url);

    const weights = new Map();
    const addAll = (list, w, cap = Infinity) => {
      for (const t of list) {
        const now = weights.get(t) || 0;
        if (now < cap) weights.set(t, now + w);
      }
    };
    addAll(terms(page.title), WEIGHTS.title);
    addAll(urlTerms(page.url), WEIGHTS.url);
    addAll(terms((page.headings || []).join(" ")), WEIGHTS.heading, 10);
    addAll(terms(page.description), WEIGHTS.description, 6);
    addAll(terms(text.slice(0, 100_000)), WEIGHTS.text, 30);
    const top = [...weights].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_PAGE);
    const length = top.reduce((s, [, w]) => s + w, 0) || 1;

    const id = this.nextId++;
    const doc = {
      id,
      url: page.url,
      host: hostOf(page.url),
      title: String(page.title || "").slice(0, 300),
      description: String(page.description || "").slice(0, 400),
      text: text.slice(0, SNIPPET_TEXT),
      terms: top.map(([t, w]) => `${t}:${Math.round(w * 10) / 10}`).join(" "),
      length,
      lang: page.lang || null,
      crawled: page.crawled || Date.now(),
      hash,
    };
    this.#insert(doc);
    // Links to other sites count for those pages.
    const seen = new Set();
    for (const l of page.links || []) {
      const host = hostOf(l.url);
      if (!host || host === doc.host || seen.has(l.url)) continue;
      seen.add(l.url);
      this.inlinks.set(l.url, (this.inlinks.get(l.url) || 0) + 1);
    }
    if (this.inlinks.size > 300_000) this.#trimInlinks();
    this.dirty = true;
    return { id };
  }

  #insert(doc) {
    this.docs.set(doc.id, doc);
    this.byUrl.set(doc.url, doc.id);
    this.hashes.set(doc.hash, doc.id);
    this.totalLength += doc.length;
    for (const pair of doc.terms.split(" ")) {
      const i = pair.lastIndexOf(":");
      if (i <= 0) continue;
      const t = pair.slice(0, i);
      let list = this.postings.get(t);
      if (!list) this.postings.set(t, (list = []));
      list.push(doc.id, Number(pair.slice(i + 1)));
    }
  }

  remove(url) {
    const id = this.byUrl.get(url);
    if (!id) return false;
    const doc = this.docs.get(id);
    this.docs.delete(id);
    this.byUrl.delete(url);
    if (this.hashes.get(doc.hash) === id) this.hashes.delete(doc.hash);
    this.totalLength -= doc.length;
    this.dead += doc.terms.split(" ").length;
    this.dirty = true;
    if (this.dead > 200_000) this.#compact();
    return true;
  }

  // Drop the postings of removed pages.
  #compact() {
    for (const [t, list] of this.postings) {
      const kept = [];
      for (let i = 0; i < list.length; i += 2) if (this.docs.has(list[i])) kept.push(list[i], list[i + 1]);
      if (kept.length) this.postings.set(t, kept);
      else this.postings.delete(t);
    }
    this.dead = 0;
  }

  #trimInlinks() {
    const keep = [...this.inlinks].sort((a, b) => b[1] - a[1]).slice(0, 150_000);
    this.inlinks = new Map(keep);
  }

  // Search. Results are judged on the whole search, not word by word:
  //   1. coverage: how much of the search a page has. Words count by how rare
  //      (telling) they are, so missing "kite" costs more than missing "well".
  //      Pages with (nearly) all of it come first; pages with only part of it
  //      come after them, marked with what they're missing.
  //   2. closeness: the words near each other in the page, and in the order you
  //      typed them ("paper kite" beats a page with "paper" and "kite" far apart).
  //   3. related words: words the best matches have in common (a search about
  //      making kites brings up "string", "tail", "spar"...) lift pages about the
  //      same thing.
  //   4. BM25 for each word, title/address/headings, links from other sites.
  // Returns { results: [{ url, title, host, snippet: [{ text, hit }], missing }], total, complete, related }.
  search(q, { page = 1, perPage = 10 } = {}) {
    const query = typeof q === "string" ? parseQuery(q) : q;
    const empty = { results: [], total: 0, complete: 0, related: [], query: query.text };
    if (!query.terms.length && !query.site) return empty;
    const N = this.docs.size || 1;
    const avg = this.totalLength / N || 1;
    const idfOf = (df) => Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const bm25 = (idf, w, doc) => (idf * (w * (K1 + 1))) / (w + K1 * (1 - B + (B * doc.length) / avg));

    // Each word's weight in the search: its rarity. A word no page has still
    // counts (nothing matches it fully), at the rarest weight.
    const qt = query.terms.map((t) => {
      const list = this.postings.get(t) || [];
      return { term: t, list, idf: idfOf(list.length / 2) };
    });
    const totalIdf = qt.reduce((s, t) => s + t.idf, 0) || 1;

    const cand = new Map(); // id -> { doc, bm: 0, got: Set(term), gotIdf: 0, related: 0 }
    qt.forEach(({ term, list, idf }) => {
      for (let i = 0; i < list.length; i += 2) {
        const doc = this.docs.get(list[i]);
        if (!doc) continue;
        let c = cand.get(doc.id);
        if (!c) cand.set(doc.id, (c = { doc, bm: 0, got: new Set(), gotIdf: 0, related: 0 }));
        c.bm += bm25(idf, list[i + 1], doc);
        c.got.add(term);
        c.gotIdf += idf;
      }
    });
    // site: alone lists that site's pages.
    if (!query.terms.length && query.site) for (const d of this.docs.values()) if (siteMatches(d.host, query.site)) cand.set(d.id, { doc: d, bm: 1, got: new Set(), gotIdf: 0, related: 0 });

    // Narrowing: site: and "exact phrases".
    for (const [id, c] of cand) {
      if (query.site && !siteMatches(c.doc.host, query.site)) cand.delete(id);
      else if (query.phrases.length) {
        const hay = fold(c.doc.title + " " + c.doc.description + " " + c.doc.text);
        if (!query.phrases.every((p) => hay.includes(p))) cand.delete(id);
      }
    }
    const coverageOf = (c) => (query.terms.length ? c.gotIdf / totalIdf : 1);
    const base = (c) => c.bm * (0.15 + 0.85 * coverageOf(c) ** 2);

    // Related words, from the pages that match the whole search best.
    const related = [];
    if (query.terms.length && N >= 20) {
      const best = [...cand.values()].filter((c) => coverageOf(c) >= 0.6).sort((a, b) => base(b) - base(a)).slice(0, 8);
      if (best.length >= 2) {
        const pool = new Map(); // term -> { weight, pages }
        for (const c of best) {
          for (const pair of c.doc.terms.split(" ")) {
            const i = pair.lastIndexOf(":");
            const t = pair.slice(0, i);
            if (i <= 0 || query.terms.includes(t) || t.length < 3 || /^\d+$/.test(t)) continue;
            const e = pool.get(t) || { weight: 0, pages: 0 };
            e.weight += Number(pair.slice(i + 1));
            e.pages++;
            pool.set(t, e);
          }
        }
        for (const [t, e] of pool) {
          const df = (this.postings.get(t) || []).length / 2;
          if (e.pages < 2 || df > N * 0.25) continue; // in one page only, or in everything
          related.push({ term: t, score: e.weight * e.pages * idfOf(df) });
        }
        related.sort((a, b) => b.score - a.score);
        related.splice(6);
        for (const r of related) {
          const list = this.postings.get(r.term) || [];
          const idf = idfOf(list.length / 2) * 0.3;
          for (let i = 0; i < list.length; i += 2) {
            const c = cand.get(list[i]);
            if (c) c.related += bm25(idf, list[i + 1], c.doc); // only lifts pages that match the search
          }
        }
      }
    }

    // Closeness and order, read from the page's text, for the most promising pages.
    const ordered = [...cand.values()].sort((a, b) => base(b) - base(a));
    const close = new Map();
    if (query.terms.length > 1) for (const c of ordered.slice(0, 300)) close.set(c.doc.id, closeness(c.doc, query.terms));

    const ranked = [];
    for (const c of ordered) {
      const { doc } = c;
      const coverage = coverageOf(c);
      let score = base(c) + c.related;
      const near = close.get(doc.id);
      if (near) score *= 1 + 0.8 * near.closeness + (near.inOrder ? 0.5 : 0);
      const title = fold(doc.title);
      if (query.terms.length > 1 && title.includes(fold(query.text))) score *= 1.5;
      const hostWords = doc.host.split(/[.-]/);
      if (query.terms.some((t) => hostWords.includes(t))) score *= 1.3;
      const links = this.inlinks.get(doc.url) || 0;
      score *= 1 + 0.15 * Math.log2(1 + links);
      const depth = pathDepth(doc.url);
      if (depth === 0) score *= 1.15;
      else if (depth > 3) score *= 0.92;
      // Pages with (nearly) all of the search come before pages with part of it.
      const complete = query.terms.length <= 1 || coverage >= 0.8 || c.got.size === query.terms.length;
      ranked.push({ doc, score, complete, coverage, missing: query.terms.filter((t) => !c.got.has(t)).map((t) => (query.words && query.words.get(t)) || t) });
    }
    ranked.sort((a, b) => b.complete - a.complete || b.score - a.score);
    // Pages with only a small part of the search (say, just its most common
    // word) aren't about it: dropped when other pages cover much more of it.
    const completeCount = ranked.filter((r) => r.complete).length;
    const bestCoverage = ranked.reduce((m, r) => Math.max(m, r.coverage), 0);
    const floor = Math.max(0.3, bestCoverage * 0.5);
    const kept = query.terms.length >= 2 && ranked.some((r) => r.coverage >= floor) ? ranked.filter((r) => r.complete || r.coverage >= floor) : ranked;

    // At most two results per site in a row, so one site can't fill the page.
    const spread = [];
    const later = [];
    const perHost = new Map();
    for (const r of kept) {
      const c = perHost.get(r.doc.host) || 0;
      if (c < 2 || query.site || !r.complete) {
        perHost.set(r.doc.host, c + 1);
        spread.push(r);
      } else later.push(r);
    }
    // (spread keeps complete results first; site-limited extras go after them)
    const all = spread.filter((r) => r.complete).concat(later, spread.filter((r) => !r.complete));
    const start = (Math.max(1, page) - 1) * perPage;
    return {
      query: query.text,
      total: all.length,
      complete: completeCount,
      related: related.map((r) => r.term),
      results: all.slice(start, start + perPage).map(({ doc, score, missing, complete }) => ({
        url: doc.url,
        title: doc.title || doc.url,
        host: doc.host,
        snippet: snippet(doc, query),
        missing: complete ? [] : missing,
        score: Math.round(score * 100) / 100,
      })),
    };
  }

  // Titles that start with what you've typed (for suggestions).
  suggest(prefix, n = 6) {
    const p = fold(prefix).trim();
    if (p.length < 2) return [];
    const out = new Set();
    for (const doc of this.docs.values()) {
      const t = fold(doc.title);
      if (t.startsWith(p)) out.add(doc.title.slice(0, 80));
      if (out.size >= n) break;
    }
    return [...out];
  }

  stats() {
    return { pages: this.docs.size, terms: this.postings.size, maxPages: this.maxPages, sites: new Set([...this.docs.values()].map((d) => d.host)).size };
  }

  // ---------- saving ----------
  // One JSON line per page; the word lists are rebuilt when loading.

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.inlinks) {
          this.inlinks = new Map(r.inlinks);
          continue;
        }
        if (!r.u || this.byUrl.has(r.u)) continue;
        this.#insert({ id: this.nextId++, url: r.u, host: hostOf(r.u), title: r.t || "", description: r.d || "", text: r.x || "", terms: r.m || "", length: r.l || 1, lang: r.g || null, crawled: r.c || 0, hash: r.h || "" });
      } catch {}
    }
  }

  serialize() {
    const lines = [JSON.stringify({ inlinks: [...this.inlinks].filter(([, c]) => c > 0).slice(0, 150_000) })];
    for (const d of this.docs.values()) lines.push(JSON.stringify({ u: d.url, t: d.title, d: d.description, x: d.text, m: d.terms, l: d.length, g: d.lang, c: d.crawled, h: d.hash }));
    return lines.join("\n") + "\n";
  }

  // Saved by writing a new file and renaming it, so a crash never leaves half a file.
  saveNow() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, this.serialize());
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  async save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      await fs.promises.writeFile(tmp, this.serialize());
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      console.log(`[search] couldn't save the index: ${err.message}`);
    }
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function siteMatches(host, site) {
  return host === site || host.endsWith("." + site);
}

// How close together a page has the search's words: the shortest stretch of
// the page holding all the words it has (1 = side by side), and whether they
// appear there in the order typed.
export function closeness(doc, queryTerms) {
  const want = new Map(queryTerms.map((t, i) => [t, i]));
  const tokens = terms(doc.title + " . " + doc.description + " . " + doc.text);
  const hits = [];
  tokens.forEach((t, pos) => want.has(t) && hits.push([pos, want.get(t)]));
  const present = new Set(hits.map((h) => h[1])).size;
  if (present < 2) return { closeness: 0, inOrder: false };
  let best = Infinity;
  const count = new Map();
  let have = 0;
  for (let l = 0, r = 0; r < hits.length; r++) {
    const k = hits[r][1];
    count.set(k, (count.get(k) || 0) + 1);
    if (count.get(k) === 1) have++;
    while (have === present) {
      best = Math.min(best, hits[r][0] - hits[l][0] + 1);
      const kl = hits[l][1];
      count.set(kl, count.get(kl) - 1);
      if (count.get(kl) === 0) have--;
      l++;
    }
  }
  // The whole search, word after word, somewhere in the page.
  let inOrder = false;
  if (present === queryTerms.length) {
    for (let i = 0; i + queryTerms.length <= tokens.length && !inOrder; i++) {
      inOrder = queryTerms.every((t, j) => tokens[i + j] === t);
    }
  }
  return { closeness: (present / best) * (present / queryTerms.length), inOrder };
}

function pathDepth(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 9;
  }
}

// The best ~30 words of a page for this search, with the matching words marked.
// Returned as pieces of text (never HTML): [{ text, hit }].
export function snippet(doc, query, size = 30) {
  const wanted = new Set(query.terms);
  const source = doc.text || doc.description || "";
  const raw = source.split(/\s+/).filter(Boolean);
  if (!raw.length) return doc.description ? [{ text: doc.description, hit: false }] : [];
  const isHit = raw.map((w) => {
    const ws = words(w);
    return ws.some((x) => wanted.has(stem(x)));
  });
  // The window with the most different matching words.
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.max(1, raw.length - size + 1); i += 3) {
    const seen = new Set();
    for (let j = i; j < Math.min(raw.length, i + size); j++) if (isHit[j]) for (const x of words(raw[j])) seen.add(stem(x));
    if (seen.size > bestScore) {
      bestScore = seen.size;
      best = i;
    }
  }
  // Nothing matched in the text: the description reads better.
  if (bestScore <= 0 && doc.description) return [{ text: doc.description, hit: false }];
  const parts = [];
  const end = Math.min(raw.length, best + size);
  if (best > 0) parts.push({ text: "… ", hit: false });
  for (let j = best; j < end; j++) {
    const text = raw[j] + (j < end - 1 ? " " : "");
    const last = parts[parts.length - 1];
    if (last && last.hit === isHit[j]) last.text += text;
    else parts.push({ text, hit: isHit[j] });
  }
  if (end < raw.length) parts.push({ text: " …", hit: false });
  return parts;
}
