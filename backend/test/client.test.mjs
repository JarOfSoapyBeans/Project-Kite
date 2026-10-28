// The script Kite injects into every page must always be valid JavaScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteHtml } from "../proxy.js";

test("injected client script parses and installs the Stage 2 hooks", () => {
  const html = rewriteHtml("<head></head><body></body>", "https://example.com/page");
  const js = html.match(/<script data-kite>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
  for (const hook of ["window.fetch", "XMLHttpRequest.prototype.open", "sendBeacon", "window.open", "MutationObserver", "navigate", "pushState"]) {
    assert.ok(js.includes(hook), hook);
  }
});
