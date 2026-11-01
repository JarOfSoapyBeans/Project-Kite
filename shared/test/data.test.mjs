import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "../lib/data.js";

test("history: visits newest first; reloads don't repeat; only websites; titles fill in", () => {
  let h = [];
  h = D.addVisit(h, { url: "https://a.test/", title: "A", time: 1000 });
  h = D.addVisit(h, { url: "https://a.test/", title: "A2", time: 20_000 });
  h = D.addVisit(h, { url: "kite://settings", time: 30_000 });
  h = D.addVisit(h, { url: "https://b.test/", time: 200_000 });
  h = D.setVisitTitle(h, "https://b.test/", "B");
  assert.deepEqual(h.map((v) => [v.url, v.title]), [["https://b.test/", "B"], ["https://a.test/", "A2"]]);
  h = D.addVisit(h, { url: "https://a.test/", title: "A", time: 300_000 });
  assert.equal(h.length, 3, "a later visit is a new entry");
  assert.deepEqual(D.searchHistory(h, "b.TEST").map((v) => v.title), ["B"]);
  assert.equal(D.removeVisits(h, [200_000]).length, 2);
  let big = [];
  for (let i = 0; i < D.MAX_HISTORY + 10; i++) big = D.addVisit(big, { url: "https://x.test/" + i, time: i * 100_000 });
  assert.equal(big.length, D.MAX_HISTORY);
});

test("day labels and most visited", () => {
  const now = new Date(2026, 9, 31, 15).getTime();
  assert.equal(D.dayLabel(now - 3600_000, now), "Today");
  assert.equal(D.dayLabel(now - 86_400_000, now), "Yesterday");
  const h = [{ url: "https://b/", title: "B", time: 3 }, { url: "https://a/", title: "A", time: 2 }, { url: "https://a/", title: "", time: 1 }];
  assert.deepEqual(D.topSites(h, 2), [{ url: "https://a/", title: "A" }, { url: "https://b/", title: "B" }]);
});

test("bookmarks: add once, rename, move, remove", () => {
  let b = D.addBookmark([], { url: "https://a.test/", title: "A" });
  b = D.addBookmark(b, { url: "https://a.test/", title: "again" });
  b = D.addBookmark(b, { url: "https://b.test/", title: "B" });
  b = D.addBookmark(b, { url: "javascript:alert(1)", title: "evil" });
  assert.deepEqual(b.map((x) => x.title), ["A", "B"]);
  const id = D.findBookmark(b, "https://b.test/").id;
  b = D.updateBookmark(b, id, { title: "Bee", url: "file:///etc/passwd" });
  assert.equal(D.findBookmark(b, "https://b.test/").title, "Bee", "only web addresses");
  b = D.moveBookmark(b, id, -1);
  assert.deepEqual(b.map((x) => x.title), ["Bee", "A"]);
  assert.deepEqual(D.removeBookmark(b, id).map((x) => x.title), ["A"]);
});

test("new tab shortcuts: most visited until you make your own", () => {
  const h = [{ url: "https://a/", title: "A", time: 1 }];
  assert.deepEqual(D.newTabShortcuts([], h), [{ url: "https://a/", title: "A" }]);
  const mine = D.addShortcut([], h, { url: "https://k/", title: "Kite" });
  assert.deepEqual(mine.map((s) => s.title), ["A", "Kite"]);
  assert.deepEqual(D.removeShortcut(mine, h, "https://a/").map((s) => s.title), ["Kite"]);
});

test("settings: defaults, and nothing unexpected kept", () => {
  const s = D.withDefaults({ searchEngine: "google", showHomeButton: "yes", evil: 1 });
  assert.equal(s.searchEngine, "google");
  assert.equal(s.showHomeButton, false, "wrong type ignored");
  assert.ok(!("evil" in s));
  assert.deepEqual(D.sessionFrom([{ url: "https://a/" }, { url: null }, { url: "kite://history" }]), ["https://a/"]);
});
