// The Kite DevTools page's filtering and formatting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, statusClass, kindOf, matches } from "../ui/devtools-page.js";

test("sizes and statuses", () => {
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 kB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(statusClass({ status: 200 }), "ok");
  assert.equal(statusClass({ status: 302 }), "redirect");
  assert.equal(statusClass({ status: 404 }), "bad");
  assert.equal(statusClass({ status: 0, error: "net::ERR_FAILED" }), "bad");
  assert.equal(statusClass({ status: 200, aborted: true }), "cancelled");
});

test("kinds of request, from the backend's or the app's fields", () => {
  assert.equal(kindOf({ dest: "document" }), "document");
  assert.equal(kindOf({ dest: "mainFrame" }), "document");
  assert.equal(kindOf({ dest: "", contentType: "text/javascript" }), "script");
  assert.equal(kindOf({ dest: "empty", url: "https://rr1.googlevideo.com/videoplayback?x" }), "media");
  assert.equal(kindOf({ dest: "xhr" }), "xhr");
  assert.equal(kindOf({ dest: "image" }), "image");
});

test("filtering", () => {
  const r = { method: "GET", url: "https://www.youtube.com/s/player/base.js", status: 404, dest: "script" };
  assert.ok(matches(r, "all", ""));
  assert.ok(matches(r, "failed", ""));
  assert.ok(matches(r, "script", "player 404"));
  assert.ok(!matches(r, "media", ""));
  assert.ok(!matches({ ...r, status: 200 }, "failed", ""));
  assert.ok(!matches(r, "all", "googlevideo"));
});
