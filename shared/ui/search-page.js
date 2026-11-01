// kite://search?q=... — Kite Search's results, from Kite's own index (the
// crawler and index live on the Kite backend: backend/search). The same page in
// the app and Kite Web; ctx.search(q, page) asks the backend.
// Results are set as text, never as HTML (the matching words are <b> elements
// made here, around text).

import { SEARCH_ENGINES, queryOf, searchAddress, prettyUrl } from "./lib/omnibox.js";

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};

const PER_PAGE = 10;
const OTHERS = ["bing", "duckduckgo", "google"];

export function renderSearch(root, ctx, url) {
  const { q, page } = queryOf(url);
  const box = el("input", { type: "search", name: "q", value: q, autocomplete: "off", spellcheck: false, placeholder: "Search the web with Kite", ariaLabel: "Search" });
  const form = el("form", { className: "ks-form", role: "search" }, box, el("button", { type: "submit", textContent: "Search" }));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (box.value.trim()) ctx.navigate(searchAddress(box.value.trim()));
  });
  const info = el("p", { className: "ks-info muted" });
  const list = el("ol", { className: "ks-results" });
  const pager = el("nav", { className: "ks-pager", ariaLabel: "Result pages" });
  const elsewhere = el("p", { className: "ks-elsewhere muted" });
  const page_ = el("div", { className: "kp ks" + (q ? "" : " ks-home") },
    el("div", { className: "ks-top" }, el("h1", { className: "ks-logo", textContent: "Kite" }), form),
    info, list, pager, elsewhere);
  root.append(page_);

  // The same search with another engine (Kite Search is young: it only knows
  // the pages its crawler has read so far).
  function others(lead) {
    elsewhere.textContent = "";
    if (!q) return;
    elsewhere.append(lead);
    OTHERS.forEach((id, i) => {
      const a = el("a", { href: SEARCH_ENGINES[id].url + encodeURIComponent(q), textContent: SEARCH_ENGINES[id].name });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        ctx.open(a.href, { newTab: e.ctrlKey || e.metaKey || e.shiftKey });
      });
      elsewhere.append(i ? " · " : " ", a);
    });
  }

  if (!q) {
    info.textContent = "Kite's own search engine: pages read by Kite's crawler, KiteBot.";
    return { refresh: () => null, focus: () => box.focus() };
  }
  if (!ctx.search) {
    info.textContent = "Kite Search isn't available here.";
    others("Search with");
    return { refresh: () => null };
  }

  info.textContent = "Searching…";
  (async () => {
    let r;
    try {
      r = await ctx.search(q, page);
    } catch (err) {
      info.textContent = `Kite Search couldn't answer: ${err.message}`;
      others("Search with");
      return;
    }
    if (r.error) {
      info.textContent = r.error;
      others("Search with");
      return;
    }
    const secs = ((r.took || 0) / 1000).toFixed(2);
    const known = Number(r.pages || 0).toLocaleString();
    info.textContent = r.total
      ? `${r.total.toLocaleString()} result${r.total === 1 ? "" : "s"} (${secs} seconds) from ${known} pages Kite has read`
      : `No results in the ${known} pages Kite has read so far.`;
    let marked = false;
    for (const res of r.results || []) {
      // Pages with only part of the search come after the rest: say so once.
      if (!marked && res.missing && res.missing.length) {
        marked = true;
        list.append(el("li", { className: "ks-partial muted", textContent: page === 1 && !list.childElementCount ? "No page has all of your search yet. Pages with part of it:" : "Pages with only part of your search:" }));
      }
      list.append(result(res));
    }
    drawPager(r.total);
    others(r.total < 5 ? "Kite's crawler hasn't read much about this yet. Try" : "Also search");
  })();

  function result(res) {
    const a = el("a", { className: "ks-title", href: /^https?:\/\//i.test(res.url) ? res.url : "#", textContent: res.title || res.url });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      ctx.open(res.url, { newTab: e.ctrlKey || e.metaKey || e.shiftKey });
    });
    a.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      ctx.open(res.url, { newTab: true });
    });
    const snip = el("p", { className: "ks-snippet" });
    for (const part of res.snippet || []) snip.append(part.hit ? el("b", { textContent: part.text }) : document.createTextNode(part.text));
    const missing = res.missing && res.missing.length ? el("p", { className: "ks-missing" }, "Missing: ", ...res.missing.map((w, i) => [i ? " " : "", el("s", { textContent: w })]).flat()) : null;
    return el("li", { className: "ks-result" }, el("div", { className: "ks-url", textContent: prettyUrl(res.url) }), a, snip, missing);
  }

  function drawPager(total) {
    const pages = Math.min(50, Math.ceil(total / PER_PAGE));
    if (pages <= 1) return;
    const go = (n, label = String(n)) => {
      if (n === page) return el("span", { className: "ks-current", textContent: label, ariaCurrent: "page" });
      const a = el("a", { href: "#", textContent: label });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        ctx.navigate(searchAddress(q, n));
      });
      return a;
    };
    if (page > 1) pager.append(go(page - 1, "‹ Previous"));
    const from = Math.max(1, Math.min(page - 4, pages - 9));
    for (let n = from; n <= Math.min(pages, from + 9); n++) pager.append(go(n));
    if (page < pages) pager.append(go(page + 1, "Next ›"));
  }

  return { refresh: () => null, focus: () => null };
}
