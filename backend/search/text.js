// Kite Search: turning text into the words the index uses. The same steps run
// on pages and on what you search for, so "Running kites" finds "kite runs".

const STOP = new Set(
  ("a an and are as at be but by for from has have he her his i if in into is it its of on or our she so that the their them " +
    "then there these they this to was we were what when which who will with you your").split(" ")
);

// Accents off ("café" -> "cafe"), lower case.
export function fold(text) {
  return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// A light English stemmer: plurals and common endings, careful with short words.
export function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is")) return w;
  if (w.endsWith("ing") && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith("ed") && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith("es") && /(?:sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}
function undouble(w) {
  return /([bdfglmnprt])\1$/.test(w) ? w.slice(0, -1) : w;
}

// Words in order (for snippets): [{ word, term }] where term is the stemmed form.
export function words(text) {
  return fold(text).match(/[\p{L}\p{N}]+/gu) || [];
}

// The terms of a text, stop words dropped (unless that leaves nothing).
export function terms(text, { keepStop = false } = {}) {
  const all = words(text).filter((w) => w.length <= 40);
  const kept = keepStop ? all : all.filter((w) => !STOP.has(w));
  return (kept.length ? kept : all).map(stem);
}

// Words from an address: host parts and path parts ("en.wikipedia.org/wiki/Kite").
export function urlTerms(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").split(".").slice(0, -1); // drop the ".com"
    return terms(host.join(" ") + " " + decodeURIComponent(u.pathname).replace(/[-_/.]+/g, " "), { keepStop: true });
  } catch {
    return [];
  }
}

// What you typed, understood: words, "exact phrases" and site:example.com.
export function parseQuery(q) {
  q = String(q || "").slice(0, 300);
  const phrases = [];
  let site = null;
  q = q.replace(/"([^"]+)"/g, (_m, p) => (phrases.push(fold(p).trim()), " " + p + " "));
  q = q.replace(/(?:^|\s)site:(\S+)/gi, (_m, s) => ((site = s.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")), " "));
  const list = [...new Set(terms(q))].slice(0, 10);
  return { terms: list, phrases, site, text: q.trim() };
}
