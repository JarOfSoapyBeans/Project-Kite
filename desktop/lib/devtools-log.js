// Kite DevTools, the app side (Stage 7 part 6a): what the Kite app is doing
// behind the scenes, for the kite://devtools page.
//   - every request a tab makes (address, status, type, size, time, which tab)
//   - pages' console warnings and errors, crashes, pages that couldn't load
//   - permission questions, downloads, syncing
// Kept in memory only (the last few thousand events), per profile: a window
// only sees its own profile's events. Chromium's own DevTools (F12) is still
// there for one page; this shows the whole app.

const MAX_EVENTS = 3000;

class DevtoolsLog {
  constructor(max = MAX_EVENTS) {
    this.max = max;
    this.events = [];
    this.next = 1;
    this.started = Date.now();
  }

  add(profileId, type, data = {}) {
    const event = { ...data, id: this.next++, time: Date.now(), type, profile: profileId };
    this.events.push(event);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    return event;
  }

  // A profile's events after `since` (an id), oldest first, at most `limit`.
  since(profileId, since = 0, limit = 500) {
    since = Number(since) || 0;
    const list = [];
    for (const e of this.events) {
      if (e.id <= since || e.profile !== profileId) continue;
      list.push(e);
      if (list.length >= limit) break;
    }
    return { events: list.map(({ profile, ...e }) => e), next: list.length ? list[list.length - 1].id : Math.max(since, this.next - 1) };
  }

  clear(profileId) {
    this.events = this.events.filter((e) => e.profile !== profileId);
  }

  forget(profileId) {
    this.clear(profileId); // a guest window closed, or a profile was removed
  }
}

const header = (headers, name) => {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
};

// Record every request made in a profile's session. tabOf(webContentsId) says
// which tab made it ({ tabId } or null for Kite itself and pop-ups).
function watchSession(ses, log, profileId, tabOf = () => null) {
  if (!ses.webRequest) return;
  const started = new Map(); // request id -> time
  ses.webRequest.onSendHeaders((d) => {
    started.set(d.id, d.timestamp || Date.now());
    if (started.size > 5000) started.delete(started.keys().next().value); // never-finished requests
  });
  const finish = (d, extra) => {
    const t0 = started.get(d.id);
    started.delete(d.id);
    if (/^(kite|devtools|chrome-extension|data|blob):/i.test(d.url)) return;
    const tab = tabOf(d.webContentsId);
    log.add(profileId, "request", {
      method: d.method,
      url: String(d.url).slice(0, 2000),
      dest: d.resourceType || "",
      tab: tab ? tab.tabId : null,
      ms: t0 ? Math.max(0, Math.round((d.timestamp || Date.now()) - t0)) : null,
      ...extra,
    });
  };
  ses.webRequest.onCompleted((d) => {
    const length = Number(header(d.responseHeaders, "content-length"));
    finish(d, {
      status: d.statusCode,
      source: d.fromCache ? "cache" : "network",
      contentType: String(header(d.responseHeaders, "content-type") || "").split(";")[0],
      bytes: Number.isFinite(length) ? length : null,
    });
  });
  ses.webRequest.onErrorOccurred((d) => {
    finish(d, { status: 0, source: "network", error: d.error, aborted: d.error === "net::ERR_ABORTED" });
  });
}

// Pages' console messages: Electron 35+ passes one event object; older
// versions passed (event, level, message, line, sourceId).
const LEVELS = { 0: "log", 1: "log", 2: "warn", 3: "error", verbose: "log", info: "log", debug: "log", warning: "warn", error: "error" };
function consoleMessage(args) {
  const [e, level, message, line, source] = args;
  if (e && typeof e === "object" && "message" in e) return { level: LEVELS[e.level] || "log", text: String(e.message), line: e.lineNumber, source: e.sourceId };
  return { level: LEVELS[level] || "log", text: String(message), line, source };
}

module.exports = { DevtoolsLog, watchSession, consoleMessage, MAX_EVENTS };
