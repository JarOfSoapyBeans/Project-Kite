// Kite Search: what a page says, from its HTML (no dependencies, no running
// anything): title, description, readable text, links, and what the page asks
// of search engines (noindex, nofollow, canonical address).

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s) => decodeEntities(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
}

function meta(html, key) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const n = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    if (n === key) return attr(tag, "content");
  }
  return null;
}

export function extract(html, pageUrl) {
  html = String(html || "").slice(0, 3_000_000);
  const head = (/<head\b[\s\S]*?<\/head>/i.exec(html) || [html.slice(0, 20000)])[0];
  const robots = fold(meta(head, "robots") || "") + " " + fold(meta(head, "kitebot") || "");
  let title = clean((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head) || [])[1] || meta(head, "og:title") || "");
  const description = clean(meta(head, "description") || meta(head, "og:description") || "").slice(0, 400);

  let canonical = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    if (/\srel\s*=\s*["']?canonical/i.test(m[0])) {
      try {
        canonical = new URL(attr(m[0], "href"), pageUrl).href;
      } catch {}
    }
  }
  let base = pageUrl;
  const baseTag = /<base\b[^>]*>/i.exec(head);
  if (baseTag && attr(baseTag[0], "href")) {
    try {
      base = new URL(attr(baseTag[0], "href"), pageUrl).href;
    } catch {}
  }

  // The readable part: no scripts, styles, menus or forms.
  let body = (/<body\b[\s\S]*$/i.exec(html) || [html])[0]
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|select|textarea|button)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const headings = [...body.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => clean(m[1])).filter(Boolean).slice(0, 20);
  if (!title && headings.length) title = headings[0];

  const nofollowAll = /nofollow|none/.test(robots);
  const links = [];
  if (!nofollowAll) {
    for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attr(m[1], "href");
      if (!href || /^\s*(javascript|mailto|tel|data):/i.test(href)) continue;
      if (/\srel\s*=\s*["'][^"']*nofollow/i.test(m[1])) continue;
      try {
        const u = new URL(href, base);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        u.hash = "";
        links.push({ url: u.href, text: clean(m[2]).slice(0, 120) });
      } catch {}
      if (links.length >= 400) break;
    }
  }

  const text = clean(body.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, " . "))
    .replace(/(\s\.)+/g, " .")
    .replace(/([.!?:;,])\s\./g, "$1")
    .replace(/^[\s.]+/, "");
  const lang = (/<html\b[^>]*\slang\s*=\s*["']?([a-z]{2,3})/i.exec(html) || [])[1] || null;

  return {
    title: title.slice(0, 300),
    description,
    headings,
    text: text.slice(0, 200_000),
    links,
    canonical,
    lang: lang && lang.toLowerCase(),
    noindex: /noindex|none/.test(robots),
    nofollow: nofollowAll,
  };
}

function fold(s) {
  return String(s || "").toLowerCase();
}
