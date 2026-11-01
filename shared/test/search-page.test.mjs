// The Kite Search page's addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryOf, searchAddress, prettyUrl } from "../lib/omnibox.js";

test("search addresses", () => {
  assert.equal(searchAddress("red kite"), "kite://search?q=red%20kite");
  assert.equal(searchAddress("a&b", 3), "kite://search?q=a%26b&page=3");
  assert.deepEqual(queryOf("kite://search?q=a%26b&page=3"), { q: "a&b", page: 3 });
  assert.deepEqual(queryOf("kite://search"), { q: "", page: 1 });
  assert.deepEqual(queryOf("kite://search?q=x&page=999"), { q: "x", page: 50 });
  assert.equal(prettyUrl("https://www.example.com/wiki/Red_kite"), "example.com › wiki › Red_kite");
});
