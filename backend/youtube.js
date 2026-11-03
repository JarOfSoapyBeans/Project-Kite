// Kite Web: YouTube videos with YouTube's embedded player.
//
// YouTube's full watch page has two problems inside Kite Web:
//   1. In some browsers (Edge, sometimes Chrome) it crashes the tab when shown
//      inside a frame, and every Kite Web tab is a frame. On its own it plays.
//   2. Its anti-bot check (BotGuard) can tell it isn't really on youtube.com and
//      gives the player no token, so YouTube stops the video after about a minute.
// YouTube's embedded player (youtube.com/embed/..., what other websites use) is
// made to run inside frames, and for most videos plays without that token. So
// when Kite Web opens a video (youtube.com/watch?v=..., /shorts/..., /live/...,
// youtu.be/...), Kite shows its own page with the embedded player, the video's
// title and channel, and a link to the full YouTube page (comments, related
// videos...). The tab still shows the real watch address.
//
// Switch it off in Kite DevTools -> Switches, or with KITE_YOUTUBE_EMBED=0.
// Only Kite Web: the Kite app's tabs are real browser pages.

export const youtubeSettings = {
  embed: typeof process === "undefined" || process.env.KITE_YOUTUBE_EMBED !== "0",
  // Inside Kite Web's frame, tell YouTube protected video (DRM: Widevine,
  // PlayReady) isn't available. YouTube's full page checks for it as it starts;
  // on Edge that reaches PlayReady's hardware video path, a suspect for the crash
  // inside frames. Ordinary videos don't use DRM. KITE_YOUTUBE_DRM=1 allows it.
  hideDrm: typeof process === "undefined" || process.env.KITE_YOUTUBE_DRM !== "1",
};

export const FULL_PAGE_PARAM = "kite_full"; // ...watch?v=ID&kite_full=1: the real watch page

const ID = /^[A-Za-z0-9_-]{11}$/;

// "1h2m3s", "90s", "90" -> seconds.
function seconds(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

// The video an address is for, or null: { id, start, list, url }.
export function youtubeVideo(address) {
  let u;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.searchParams.get(FULL_PAGE_PARAM) === "1") return null;
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (/^(www\.|m\.)?youtube\.com$/.test(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = /^\/(shorts|live)\/([^/]+)/.exec(u.pathname);
      if (m) id = m[2];
    }
  }
  if (!id || !ID.test(id)) return null;
  const list = u.searchParams.get("list");
  return {
    id,
    start: seconds(u.searchParams.get("t") || u.searchParams.get("start")),
    list: list && /^[A-Za-z0-9_-]{10,64}$/.test(list) ? list : null,
    url: u.href,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The video's title and channel, from YouTube's oEmbed (a small public JSON
// file about a video). Never waits long: the page works without it.
export async function videoInfo(id, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { unavailable: r.status === 401 || r.status === 403 ? "private" : r.status === 404 ? "missing" : null };
    const j = await r.json();
    return { title: String(j.title || "").slice(0, 300), channel: String(j.author_name || "").slice(0, 200), channelUrl: /^https:\/\/www\.youtube\.com\//.test(j.author_url) ? j.author_url : null };
  } catch {
    return {};
  }
}

// Kite's page for a video. Absolute youtube.com addresses in it are rewritten
// to go through Kite like any page's (rewriteHtml), so the player loads
// through the backend.
export function videoPage(video, info = {}) {
  const embed = new URL(`https://www.youtube.com/embed/${video.id}`);
  embed.searchParams.set("autoplay", "1");
  embed.searchParams.set("playsinline", "1");
  embed.searchParams.set("rel", "0");
  if (video.start) embed.searchParams.set("start", String(video.start));
  if (video.list) embed.searchParams.set("list", video.list);
  const full = new URL(video.url);
  if (full.hostname === "youtu.be") {
    full.hostname = "www.youtube.com";
    full.pathname = "/watch";
    full.searchParams.set("v", video.id);
  }
  full.searchParams.set(FULL_PAGE_PARAM, "1");
  const title = info.title || "YouTube";
  const note =
    info.unavailable === "private" ? "This video is private or can't be shown outside YouTube." : info.unavailable === "missing" ? "This video isn't available." : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title === "YouTube" ? title : title + " - YouTube")}</title>
<meta name="kite-video" content="${esc(video.id)}">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0f0f0f; color: #f1f1f1; font: 14px/1.4 Roboto, "Segoe UI", Arial, sans-serif; }
  main { max-width: 1280px; margin: 0 auto; padding: 16px 24px 32px; }
  .player { position: relative; width: 100%; aspect-ratio: 16 / 9; max-height: calc(100vh - 150px); background: #000; border-radius: 12px; overflow: hidden; margin: 0 auto; }
  .player iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  h1 { font-size: 20px; font-weight: 600; margin: 14px 0 6px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; color: #aaa; }
  a { color: #3ea6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .channel { color: #f1f1f1; font-weight: 500; }
  .note { color: #aaa; font-size: 13px; margin-top: 12px; }
  .warn { color: #f2cc60; }
</style></head>
<body><main>
  <div class="player"><iframe src="${esc(embed.href)}" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen; accelerometer; gyroscope; clipboard-write; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>
  <h1>${esc(title)}</h1>
  <div class="row">
    ${info.channel ? (info.channelUrl ? `<a class="channel" href="${esc(info.channelUrl)}">${esc(info.channel)}</a>` : `<span class="channel">${esc(info.channel)}</span>`) : ""}
    <a href="${esc(full.href)}">Open the full YouTube page</a>
    <a href="https://www.youtube.com/">YouTube home</a>
  </div>
  ${note ? `<p class="note warn">${esc(note)}</p>` : ""}
  <p class="note">Kite Web plays YouTube videos with YouTube's embedded player, which works better inside Kite Web. The full page has comments and related videos.</p>
</main></body></html>`;
}

// On youtube.com pages: YouTube changes pages without loading them (clicking a
// video on the home page just swaps the content in), which would show the full
// watch page after all. A video address pushed that way becomes a real page
// load, which Kite answers with its video page. Runs after Kite's page script.
// redirect: also turn video changes into Kite's video page (the embedded-player switch).
// hideDrm: inside a frame, answer YouTube's DRM checks with "not available".
export function youtubeNavScript(redirect = true, hideDrm = true) {
  return `<script data-kite>(function () {
  var fake = window.__kite$fakeLocation;
  if (!fake || window.__kite$skipNavigation) return;
  // Only inside Kite Web's frame (a page shown on its own needs none of this).
  var redirect = ${redirect ? "true" : "false"} && window.top !== window;
  function video(u) {
    try {
      var x = new URL(u, fake.href);
      return /(^|\\.)youtube\\.com$/.test(x.hostname) && (x.pathname === "/watch" || /^\\/(shorts|live)\\//.test(x.pathname)) && x.searchParams.get("${FULL_PAGE_PARAM}") !== "1" ? x.href : null;
    } catch (e) { return null; }
  }
  function onVideoPage() { return !!document.querySelector('meta[name="kite-video"]'); }
  var going = false;
  // Stop the page's players (see stopMedia in Kite's page script), then go, and
  // stop them again right before leaving: YouTube may start a new player for
  // the clicked video in between (the tunnel log showed one buffering as the
  // home page was torn down).
  function stop(why) { if (window.__kite$stopMedia) window.__kite$stopMedia(why); }
  function go(to) {
    if (going) return true;
    going = true;
    stop("opening a video");
    setTimeout(function () { stop("leaving for the video"); fake.assign(to); }, 30);
    return true;
  }
  function idOf(u) {
    try {
      var x = new URL(u, fake.href);
      return x.searchParams.get("v") || (/^\\/(?:shorts|live)\\/([^/?#]+)/.exec(x.pathname) || [])[1] || null;
    } catch (e) { return null; }
  }
  // Called by Kite's history patch (every frame's pushState/replaceState) with
  // the real address: true = Kite took care of it. Only pushState opens a page;
  // replaceState just tidies the current one (YouTube removes kite_full=1 from
  // the address that way), and the same video is never a new page.
  Object.defineProperty(window, "__kite$videoNav", { value: function (href, how) {
    if (!redirect || how !== "pushState" || onVideoPage()) return false;
    var to = video(href);
    if (!to || idOf(to) === idOf(fake.href)) return false;
    return go(to);
  } });
  // YouTube reloads the whole page (…&themeRefresh=1) when the theme it drew
  // differs from your system's light/dark setting. Inside Kite's frame that
  // reload, with the player starting, crashed the page (Edge). The theme is
  // remembered in a cookie that Kite keeps, so the next page is drawn right
  // anyway: the reload is skipped.
  Object.defineProperty(window, "__kite$skipNavigation", { value: function (to, now) {
    try {
      var a = new URL(to), b = new URL(now);
      if (!a.searchParams.has("themeRefresh") || a.pathname !== b.pathname) return null;
      a.searchParams.delete("themeRefresh");
      b.searchParams.delete("themeRefresh");
      return a.searchParams.toString() === b.searchParams.toString() ? "YouTube reloading only to change light/dark theme" : null;
    } catch (e) { return null; }
  } });
  // Protected video (DRM) checks: logged, and inside Kite Web's frame answered
  // "not available" (see youtubeSettings.hideDrm).
  var noDrm = ${hideDrm ? "true" : "false"} && window.top !== window, drmSeen = {};
  function tell(text) {
    try { if (window.__kite$log) window.__kite$log("media", text); } catch (e) {}
  }
  var askDrm = navigator.requestMediaKeySystemAccess;
  if (askDrm) navigator.requestMediaKeySystemAccess = function (keySystem) {
    var ks = String(keySystem);
    if (!drmSeen[ks]) {
      drmSeen[ks] = 1;
      tell("asked for protected video (DRM) " + ks + (noDrm ? ": Kite answered not available" : ": allowed"));
    }
    if (noDrm) return Promise.reject(new DOMException("Unsupported keySystem or supportedConfigurations.", "NotSupportedError"));
    return askDrm.apply(navigator, arguments);
  };
  // A click on a link to a video: Kite gets it before YouTube does, so YouTube
  // never starts playing it inside the page that's about to be left.
  window.addEventListener("click", function (e) {
    if (!redirect || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || onVideoPage()) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || (a.target && a.target !== "_self")) return;
    var to = video(a.getAttribute("href"));
    if (!to || idOf(to) === idOf(fake.href)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    go(to);
  }, true);
  // YouTube announces its own page changes: a second net.
  document.addEventListener("yt-navigate-start", function (e) {
    var u = e && e.detail && (e.detail.url || (e.detail.endpoint && e.detail.endpoint.commandMetadata && e.detail.endpoint.commandMetadata.webCommandMetadata && e.detail.endpoint.commandMetadata.webCommandMetadata.url));
    var to = u && redirect && !onVideoPage() ? video(u) : null;
    if (to && idOf(to) !== idOf(fake.href)) go(to);
  }, true);
})();</script>`;
}

export function isYouTubePage(address) {
  try {
    return /(^|\.)youtube\.com$/.test(new URL(address).hostname);
  } catch {
    return false;
  }
}
