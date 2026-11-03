// Kite DevTools, the backend side (Stage 7 part 6a): what Kite is doing behind
// the scenes, for the kite://devtools page.
//   - every request Kite proxies (address, status, who answered, size, time)
//   - everything the backend prints (its log: [kite 404], [page error], [video],
//     [PAGE CRASH]...)
//   - live switches: Kite's page-script parts, script rewriting, the video log
//     (the same things KITE_CLIENT_OFF, KITE_JS_REWRITE and KITE_MEDIA_LOG set
//     at start, changeable without a restart)
// Kept in memory only (the last few thousand events). The log shows everyone's
// browsing, so only Kite accounts named in KITE_DEVTOOLS_USERS may see it.
// No dependencies.

import { rewriteSettings, cacheStats } from "./jsrewrite.js";
import { pageScriptOff, CLIENT_PARTS, mediaLog, assetLog, compressedStats } from "./proxy.js";
import { youtubeSettings } from "./youtube.js";

const MAX_EVENTS = 3000;

export class DevtoolsHub {
  constructor(max = MAX_EVENTS) {
    this.max = max;
    this.events = [];
    this.next = 1;
    this.started = Date.now();
  }

  add(type, data) {
    const event = { ...data, id: this.next++, time: Date.now(), type };
    this.events.push(event);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    return event;
  }

  // Events after `since` (an id), oldest first, at most `limit`.
  since(since = 0, limit = 500) {
    const from = this.events.findIndex((e) => e.id > since);
    const list = from < 0 ? [] : this.events.slice(from, from + limit);
    return { events: list, next: list.length ? list[list.length - 1].id : Math.max(Number(since) || 0, this.next - 1) };
  }

  clear() {
    this.events = [];
  }
}

export const hub = new DevtoolsHub();

// Everything the backend prints also goes to the hub (once per process).
let captured = false;
export function captureConsole(target = hub) {
  if (captured) return;
  captured = true;
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        target.add("log", { level: level === "info" ? "log" : level, text: args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(" ").slice(0, 4000) });
      } catch {}
    };
  }
}

// One proxied request, recorded when it's done (or cut off).
export function recordRequest(req, res, { realUrl, target = hub } = {}) {
  const started = Date.now();
  let bytes = 0;
  const write = res.write;
  const end = res.end;
  res.write = function (chunk, ...rest) {
    if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk);
    return write.call(this, chunk, ...rest);
  };
  res.end = function (chunk, ...rest) {
    if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk);
    return end.call(this, chunk, ...rest);
  };
  let done = false;
  const finish = (aborted) => {
    if (done) return;
    done = true;
    if (assetLog.on) printAsset(req, res, realUrl, bytes, Date.now() - started, aborted);
    target.add("request", {
      method: req.method,
      url: String(realUrl || req.url).slice(0, 2000),
      status: res.statusCode,
      source: res.getHeader("x-kite-source") || "kite",
      contentType: String(res.getHeader("content-type") || "").split(";")[0],
      dest: req.headers["sec-fetch-dest"] || "",
      bytes,
      ms: Date.now() - started,
      aborted,
    });
  };
  res.on("finish", () => finish(false));
  res.on("close", () => finish(!res.writableFinished));
}

// The backend's side of the asset log: one line per file it served.
function fmtBytes(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " kB" : n + " B";
}
function printAsset(req, res, realUrl, bytes, ms, aborted) {
  const kind = req.headers["sec-fetch-dest"] || String(res.getHeader("content-type") || "").split(";")[0] || "?";
  const from = res.getHeader("x-kite-source") === "upstream" ? "" : "  (answered by Kite)";
  console.log(`[asset ${aborted ? "cancelled" : res.statusCode}] ${kind}  ${fmtBytes(bytes)}  ${ms} ms  ${String(realUrl || req.url).slice(0, 600)}${from}`);
}

// ---------- live switches ----------

export function getSettings() {
  return {
    jsRewrite: rewriteSettings.on,
    mediaLog: mediaLog.on,
    youtubeEmbed: youtubeSettings.embed,
    youtubeHideDrm: youtubeSettings.hideDrm,
    assetLog: assetLog.on,
    clientOff: Object.keys(pageScriptOff).filter((k) => pageScriptOff[k]),
  };
}

export function setSettings(changes = {}) {
  if (typeof changes.jsRewrite === "boolean") rewriteSettings.on = changes.jsRewrite;
  if (typeof changes.mediaLog === "boolean") mediaLog.on = changes.mediaLog;
  if (typeof changes.youtubeEmbed === "boolean") youtubeSettings.embed = changes.youtubeEmbed;
  if (typeof changes.youtubeHideDrm === "boolean") youtubeSettings.hideDrm = changes.youtubeHideDrm;
  if (typeof changes.assetLog === "boolean") assetLog.on = changes.assetLog;
  if (Array.isArray(changes.clientOff)) {
    for (const k of Object.keys(pageScriptOff)) delete pageScriptOff[k];
    for (const k of changes.clientOff) if (CLIENT_PARTS[k]) pageScriptOff[k] = true;
  }
  const now = getSettings();
  console.log(`[devtools] settings: script rewriting ${now.jsRewrite ? "on" : "OFF"}, video log ${now.mediaLog ? "on" : "off"}, YouTube embedded player ${now.youtubeEmbed ? "on" : "off"}, YouTube DRM ${now.youtubeHideDrm ? "hidden" : "allowed"}, asset log ${now.assetLog ? "on" : "off"}` +
    (now.clientOff.length ? `, page-script parts OFF: ${now.clientOff.join(", ")}` : ""));
  return now;
}

export function status(sessions) {
  const m = process.memoryUsage();
  return {
    uptime: Math.round((Date.now() - hub.started) / 1000),
    node: process.version,
    memory: { rss: m.rss, heapUsed: m.heapUsed },
    sessions: sessions ? sessions.map.size : 0,
    accounts: sessions ? sessions.accounts.size : 0,
    scriptCache: cacheStats(),
    compressedCache: compressedStats(),
    events: hub.events.length,
    settings: getSettings(),
    parts: CLIENT_PARTS,
  };
}

// Who may open Kite DevTools: Kite accounts listed in KITE_DEVTOOLS_USERS
// (usernames or Google emails, comma-separated).
export function devtoolsUsers(env = process.env) {
  return String(env.KITE_DEVTOOLS_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
