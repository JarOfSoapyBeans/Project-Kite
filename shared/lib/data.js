// Kite's browsing data, as plain functions on plain objects, shared by the Kite
// app and Kite Web: history, bookmarks, new tab shortcuts and settings. Where
// it's kept (the app's profile folder, the browser, a Kite account) is the
// platform's business; these functions never touch storage.

export const MAX_HISTORY = 5000;

export const DEFAULT_SETTINGS = {
  searchEngine: "bing", // see SEARCH_ENGINES in omnibox.js
  homePage: "", // "" = the new tab page, or an address
  showHomeButton: false,
  showBookmarksBar: true,
  startup: "newtab", // "newtab" | "continue" (reopen last time's tabs) | "home"
  recordHistory: true,
};

export function withDefaults(settings) {
  const s = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(settings || {})) if (k in DEFAULT_SETTINGS && typeof v === typeof DEFAULT_SETTINGS[k]) s[k] = v;
  return s;
}

const isWeb = (url) => /^https?:\/\//i.test(String(url || ""));

// ---------- history ----------
// [{ url, title, time }] newest first.

export function addVisit(history, { url, title = "", time = Date.now() }) {
  if (!isWeb(url)) return history;
  const list = Array.isArray(history) ? history.slice() : [];
  // The same page again within a minute (reloads, redirects): just refresh it.
  if (list[0] && list[0].url === url && time - list[0].time < 60_000) {
    list[0] = { ...list[0], title: title || list[0].title, time };
    return list;
  }
  list.unshift({ url, title, time });
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
  return list;
}

// A page's title arrived after its visit was recorded.
export function setVisitTitle(history, url, title) {
  if (!title || !history || !history[0] || history[0].url !== url) return history;
  const list = history.slice();
  list[0] = { ...list[0], title };
  return list;
}

export function searchHistory(history, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return history || [];
  return (history || []).filter((v) => {
    const hay = (v.title + " " + v.url).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function removeVisits(history, times) {
  const gone = new Set(times);
  return (history || []).filter((v) => !gone.has(v.time));
}

// "Today", "Yesterday", or the date, for grouping the history page.
export function dayLabel(time, now = Date.now()) {
  const d = new Date(time);
  const start = (t) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate()).getTime();
  const days = Math.round((start(now) - start(time)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

// The sites you visit most (for the new tab page), one per address.
export function topSites(history, n = 8) {
  const counts = new Map();
  for (const v of history || []) {
    const c = counts.get(v.url) || { url: v.url, title: v.title, count: 0, last: v.time };
    c.count++;
    if (!c.title && v.title) c.title = v.title;
    counts.set(v.url, c);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, n).map(({ url, title }) => ({ url, title }));
}

// ---------- bookmarks ----------
// [{ id, url, title, created }] in the order shown on the bookmarks bar.

export function findBookmark(bookmarks, url) {
  return (bookmarks || []).find((b) => b.url === url) || null;
}

export function addBookmark(bookmarks, { url, title }) {
  if (!isWeb(url) || findBookmark(bookmarks, url)) return bookmarks || [];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return [...(bookmarks || []), { id, url, title: String(title || url).slice(0, 300), created: Date.now() }];
}

export function updateBookmark(bookmarks, id, changes) {
  return (bookmarks || []).map((b) => {
    if (b.id !== id) return b;
    const next = { ...b };
    if (typeof changes.title === "string") next.title = changes.title.slice(0, 300) || b.url;
    if (typeof changes.url === "string" && isWeb(changes.url)) next.url = changes.url;
    return next;
  });
}

export function removeBookmark(bookmarks, id) {
  return (bookmarks || []).filter((b) => b.id !== id);
}

export function moveBookmark(bookmarks, id, by) {
  const list = (bookmarks || []).slice();
  const i = list.findIndex((b) => b.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

// ---------- new tab shortcuts ----------
// Yours if you made any, otherwise your most visited sites.

export function newTabShortcuts(custom, history, n = 8) {
  if (Array.isArray(custom) && custom.length) return custom.slice(0, n);
  return topSites(history, n);
}

export function addShortcut(custom, history, { url, title }) {
  if (!isWeb(url)) return custom || [];
  const base = Array.isArray(custom) && custom.length ? custom : topSites(history);
  return [...base.filter((s) => s.url !== url), { url, title: title || url }].slice(-12);
}

export function removeShortcut(custom, history, url) {
  const base = Array.isArray(custom) && custom.length ? custom : topSites(history);
  return base.filter((s) => s.url !== url);
}

// ---------- checking stored data ----------

// Data can come from disk, another device or an old version of Kite: keep only
// the expected shape (lists of objects with a text url), so a bad value can't
// break the interface.
const isEntry = (x) => x && typeof x === "object" && typeof x.url === "string";
export function clean(name, value) {
  if (name === "settings") return withDefaults(value && typeof value === "object" ? value : {});
  if (!Array.isArray(value)) return [];
  if (name === "session") return value.filter((u) => typeof u === "string");
  return value.filter(isEntry);
}

// ---------- the last session's tabs ----------

export function sessionFrom(tabs) {
  return (tabs || []).map((t) => t.url).filter(isWeb).slice(0, 50);
}
