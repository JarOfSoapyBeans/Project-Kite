// The address bar's brain, shared by the Kite app and Kite Web: decide whether
// what you typed is an address or a search.

export const SEARCH_ENGINES = {
  kite: { name: "Kite", url: "kite://search?q=" }, // Kite's own search engine (backend/search)
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
};
export const DEFAULT_ENGINE = "kite";

// "example.com" -> https://example.com, "http://x" stays, "kites" -> a search.
export function toUrl(input, engine = DEFAULT_ENGINE) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (/^view-source:https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^[?？]\s*\S/.test(value)) return (SEARCH_ENGINES[engine] || SEARCH_ENGINES[DEFAULT_ENGINE]).url + encodeURIComponent(value.replace(/^[?？]\s*/, "")); // "?term": always a search
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return "http://" + value;
  if (!/\s/.test(value) && /^[^\s/]+\.[^\s/.]{2,}(\/.*)?$/.test(value)) return "https://" + value;
  const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES[DEFAULT_ENGINE];
  return e.url + encodeURIComponent(value);
}

// A search for exactly this text (e.g. "Search for ..." on selected text).
export function searchUrl(text, engine = DEFAULT_ENGINE) {
  const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES[DEFAULT_ENGINE];
  return e.url + encodeURIComponent(String(text || "").trim());
}

// What the address bar shows for a page (nothing for the new tab page).
export function displayUrl(url) {
  return url || "";
}

// ---------- Kite Search's addresses (kite://search?q=...&page=N) ----------

export function queryOf(url) {
  const p = new URLSearchParams(String(url || "").split("?")[1] || "");
  return { q: (p.get("q") || "").trim(), page: Math.max(1, Math.min(50, Number(p.get("page")) || 1)) };
}

export function searchAddress(q, page = 1) {
  return "kite://search?q=" + encodeURIComponent(q) + (page > 1 ? "&page=" + page : "");
}

// "https://en.wikipedia.org/wiki/Kite" -> "en.wikipedia.org › wiki › Kite"
export function prettyUrl(url) {
  try {
    const u = new URL(url);
    const parts = decodeURIComponent(u.pathname).split("/").filter(Boolean).slice(0, 4);
    return [u.hostname.replace(/^www\./, ""), ...parts].join(" › ").slice(0, 100);
  } catch {
    return String(url);
  }
}
