import { test } from "node:test";
import assert from "node:assert/strict";
import { toUrl, searchUrl } from "../lib/omnibox.js";

test("addresses and searches", () => {
  assert.equal(toUrl("example.com"), "https://example.com");
  assert.equal(toUrl("example.com/a b"), "kite://search?q=example.com%2Fa%20b");
  assert.equal(toUrl("http://x.test/p"), "http://x.test/p");
  assert.equal(toUrl("localhost:3000/x"), "http://localhost:3000/x");
  assert.equal(toUrl("kites"), "kite://search?q=kites");
  assert.equal(toUrl("kites", "bing"), "https://www.bing.com/search?q=kites");
  assert.equal(toUrl("? example.com"), "kite://search?q=example.com", "a ? in front: always a search");
  assert.equal(toUrl("how to fly a kite", "google"), "https://www.google.com/search?q=how%20to%20fly%20a%20kite");
  assert.equal(toUrl("   "), null);
  assert.equal(toUrl("view-source:https://a.test/"), "view-source:https://a.test/");
  assert.equal(searchUrl("example.com"), "kite://search?q=example.com");
});
