// Kite Web: YouTube videos with YouTube's embedded player (youtube.js).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { youtubeVideo, videoPage, youtubeSettings, youtubeNavScript } from "../youtube.js";
import { rewriteHtml, toProxyUrl, decodeUrl, PREFIX } from "../proxy.js";
import { createKiteServer } from "../app.js";

after(() => (youtubeSettings.embed = true));

test("which addresses are videos", () => {
  assert.deepEqual(youtubeVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s&list=PLabcdefghij"), { id: "dQw4w9WgXcQ", start: 90, list: "PLabcdefghij", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s&list=PLabcdefghij" });
  assert.equal(youtubeVideo("https://m.youtube.com/watch?v=dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(youtubeVideo("https://youtu.be/dQw4w9WgXcQ?t=42").start, 42);
  assert.equal(youtubeVideo("https://www.youtube.com/shorts/dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(youtubeVideo("https://www.youtube.com/live/dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  for (const not of ["https://www.youtube.com/", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&kite_full=1", "https://evil.test/watch?v=dQw4w9WgXcQ", "https://notyoutube.com/watch?v=dQw4w9WgXcQ"]) {
    assert.equal(youtubeVideo(not), null, not);
  }
});

test("Kite's video page: the embedded player, title and channel as text, a way to the full page", () => {
  const html = videoPage(youtubeVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90"), { title: 'A <b>"song"</b>', channel: "Rick & co", channelUrl: "https://www.youtube.com/@rick" });
  assert.ok(html.includes('src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&amp;playsinline=1&amp;rel=0&amp;start=90"'));
  assert.ok(html.includes("<title>A &lt;b&gt;&quot;song&quot;&lt;/b&gt; - YouTube</title>"));
  assert.ok(html.includes("Rick &amp; co") && !html.includes("<b>"));
  assert.ok(html.includes("watch?v=dQw4w9WgXcQ&amp;t=90&amp;kite_full=1"));
  assert.ok(/allow="[^"]*autoplay[^"]*encrypted-media[^"]*fullscreen/.test(html));
  assert.match(videoPage(youtubeVideo("https://youtu.be/dQw4w9WgXcQ"), { unavailable: "private" }), /private/);
  // Through Kite's rewriting, the player loads through Kite too.
  const out = rewriteHtml(html, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90");
  const src = /<iframe src="([^"]+)"/.exec(out)[1];
  assert.ok(src.startsWith(PREFIX));
  assert.equal(decodeUrl(src.slice(PREFIX.length).split(/[/?]/)[0]), "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&rel=0&start=90");
});

test("youtube.com pages get the script that turns in-page video changes into page loads", () => {
  const html = "<html><head></head><body></body></html>";
  assert.ok(rewriteHtml(html, "https://www.youtube.com/").includes("yt-navigate-start"));
  assert.ok(!rewriteHtml(html, "https://example.com/").includes("yt-navigate-start"));
  youtubeSettings.embed = false;
  assert.ok(!rewriteHtml(html, "https://www.youtube.com/").includes("yt-navigate-start"));
  youtubeSettings.embed = true;
  assert.ok(youtubeNavScript().includes("kite_full"));
});

test("a video opened in a tab gets Kite's video page; switched off, the real page is fetched", async () => {
  const k = createKiteServer({ allowedOrigins: [], log: () => {}, captureConsole: false });
  await new Promise((r) => k.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${k.server.address().port}`;
  try {
    const r = await fetch(url + toProxyUrl("https://youtu.be/dQw4w9WgXcQ?t=5"), { headers: { "sec-fetch-dest": "iframe" } });
    assert.equal(r.status, 200);
    const page = await r.text();
    assert.ok(page.includes("/embed/") || page.includes(PREFIX), "the embedded player");
    assert.ok(page.includes('"https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5"'), "the tab shows the watch address");
    assert.ok(page.includes("Open the full YouTube page"));
    // A script asking for the watch page's data isn't a page load: not answered with Kite's page.
    youtubeSettings.embed = false;
    const off = await fetch(url + toProxyUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { headers: { "sec-fetch-dest": "iframe" } });
    assert.ok(!(await off.text()).includes("Open the full YouTube page"));
  } finally {
    youtubeSettings.embed = true;
    k.server.closeAllConnections();
    k.server.close();
  }
});
