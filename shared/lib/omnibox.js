// The address bar's brain, shared by the Kite app and Kite Web: decide whether
// what you typed is an address or a search.

export const SEARCH_ENGINES = {
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
};
export const DEFAULT_ENGINE = "bing";

// "example.com" -> https://example.com, "http://x" stays, "kites" -> a search.
export function toUrl(input, engine = DEFAULT_ENGINE) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return "http://" + value;
  if (!/\s/.test(value) && /^[^\s/]+\.[^\s/.]{2,}(\/.*)?$/.test(value)) return "https://" + value;
  const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES[DEFAULT_ENGINE];
  return e.url + encodeURIComponent(value);
}

// What the address bar shows for a page (nothing for the new tab page).
export function displayUrl(url) {
  return url || "";
}
