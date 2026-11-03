// kite://devtools — what Kite is doing behind the scenes, for finding bugs.
//   Requests  every request (Kite Web: through the backend; the app: every tab's)
//   Log       Kite Web: the backend's log; the app: page errors, crashes,
//             pages that didn't load, permissions, downloads, sync
//   Status    memory, caches, sessions, versions
//   Search    Kite Web only: Kite Search's crawler (KiteBot): what it read,
//             its queue, pause/resume, add a site
//   Switches  Kite Web only: parts of Kite's page script, script rewriting,
//             the video log (live; reload the tab to see the effect)
// Drawn from platform.devtools ({ check, events, status, clear, settings }).
// Everything shown is set as text, never as HTML.

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};

const MAX_KEPT = 3000;
const POLL_MS = 1500;

export function formatBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "";
  n = Number(n);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function statusClass(r) {
  if (r.aborted) return "cancelled";
  if (!r.status || r.status >= 400) return "bad";
  if (r.status >= 300) return "redirect";
  return "ok";
}

// Kinds of request for the filter.
const KINDS = {
  all: "All",
  document: "Pages",
  script: "Scripts",
  xhr: "Fetch/XHR",
  media: "Media",
  image: "Images",
  failed: "Failed",
};
export function kindOf(r) {
  const d = String(r.dest || "").toLowerCase();
  const t = String(r.contentType || "").toLowerCase();
  if (d === "document" || d === "iframe" || d === "mainframe" || d === "subframe") return "document";
  if (d === "script" || t.includes("javascript")) return "script";
  if (d === "image" || t.startsWith("image/")) return "image";
  if (d === "video" || d === "audio" || d === "media" || t.startsWith("video/") || t.startsWith("audio/") || /videoplayback/.test(r.url)) return "media";
  if (d === "empty" || d === "xhr" || d === "fetch" || t.includes("json")) return "xhr";
  return "other";
}

export function matches(r, kind, text) {
  if (kind === "failed" && statusClass(r) === "ok") return false;
  if (kind !== "all" && kind !== "failed" && kindOf(r) !== kind) return false;
  if (!text) return true;
  const hay = `${r.method} ${r.url} ${r.status} ${r.contentType || ""} ${r.error || ""} ${r.text || ""}`.toLowerCase();
  return String(text).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour12: false });
const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname + (x.search.length > 60 ? x.search.slice(0, 60) + "…" : x.search);
  } catch {
    return String(u);
  }
};

export function renderDevtools(root, ctx) {
  const dt = ctx.devtools;
  const token = root.__kiteView;
  const alive = () => root.__kiteView === token && root.isConnected;
  const page = el("div", { className: "kp devtools" });
  root.append(page);
  if (!dt) {
    page.append(el("div", { className: "kp-head" }, el("h1", { textContent: "Kite DevTools" })), el("p", { className: "muted", textContent: "Not available here." }));
    return { refresh: () => null };
  }

  const web = ctx.platformName === "web";
  const state = { requests: [], logs: [], since: 0, paused: false, kind: "all", text: "", level: "all", logText: "", selected: null, view: "requests" };

  const head = el("div", { className: "kp-head" }, el("h1", { textContent: "Kite DevTools" }));
  const note = el("p", { className: "muted dt-note" });
  const tabsEl = el("div", { className: "dt-tabs", role: "tablist" });
  const body = el("div", { className: "dt-body" });
  page.append(head, note, tabsEl, body);

  // ---------- Requests ----------
  const reqFilter = el("input", { type: "search", placeholder: "Filter (address, status, type…)", spellcheck: false });
  const reqKind = el("select", {});
  for (const [k, label] of Object.entries(KINDS)) reqKind.append(el("option", { value: k, textContent: label }));
  const pauseBtn = el("button", { type: "button", textContent: "Pause" });
  const clearBtn = el("button", { type: "button", textContent: "Clear" });
  const copyBtn = el("button", { type: "button", textContent: "Copy as JSON" });
  const count = el("span", { className: "muted dt-count" });
  const table = el("div", { className: "dt-table", role: "table" });
  const details = el("pre", { className: "dt-details", hidden: true });
  const reqView = el("div", { className: "dt-view" },
    el("div", { className: "dt-tools" }, reqFilter, reqKind, pauseBtn, clearBtn, copyBtn, count),
    el("div", { className: "dt-row dt-headrow" }, ...["Status", "Method", "Address", "Type", "Size", "Time", "From"].map((t) => el("span", { textContent: t }))),
    table, details);

  function requestRow(r) {
    const row = el("div", { className: "dt-row " + statusClass(r), role: "row", tabIndex: 0 },
      el("span", { textContent: r.aborted ? "cancelled" : r.status ? String(r.status) : r.error ? "failed" : "" }),
      el("span", { textContent: r.method || "" }),
      el("span", { className: "dt-url", textContent: shortUrl(r.url), title: r.url }),
      el("span", { textContent: r.contentType || r.dest || "" }),
      el("span", { textContent: formatBytes(r.bytes) }),
      el("span", { textContent: r.ms === null || r.ms === undefined ? "" : `${r.ms} ms` }),
      el("span", { textContent: r.source || "" }));
    row.addEventListener("click", () => select(r, row));
    row.addEventListener("keydown", (e) => e.key === "Enter" && select(r, row));
    return row;
  }
  function select(r, row) {
    for (const x of table.querySelectorAll(".selected")) x.classList.remove("selected");
    if (state.selected === r) {
      state.selected = null;
      details.hidden = true;
      return;
    }
    state.selected = r;
    row.classList.add("selected");
    details.hidden = false;
    details.textContent = JSON.stringify({ ...r, time: new Date(r.time).toISOString() }, null, 2);
  }
  function drawRequests() {
    const shown = state.requests.filter((r) => matches(r, state.kind, state.text));
    table.textContent = "";
    const frag = document.createDocumentFragment();
    for (const r of shown.slice(-1000)) frag.append(requestRow(r));
    table.append(frag);
    count.textContent = `${shown.length} of ${state.requests.length}`;
    table.scrollTop = table.scrollHeight;
  }
  function addRequests(list) {
    const near = table.scrollHeight - table.scrollTop - table.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const r of list) if (matches(r, state.kind, state.text)) frag.append(requestRow(r));
    table.append(frag);
    while (table.childElementCount > 1000) table.firstElementChild.remove();
    count.textContent = `${state.requests.filter((r) => matches(r, state.kind, state.text)).length} of ${state.requests.length}`;
    if (near) table.scrollTop = table.scrollHeight;
  }
  reqFilter.addEventListener("input", () => ((state.text = reqFilter.value.trim()), drawRequests()));
  reqKind.addEventListener("change", () => ((state.kind = reqKind.value), drawRequests()));
  pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  });

  // ---------- Log ----------
  const logFilter = el("input", { type: "search", placeholder: "Filter the log", spellcheck: false });
  const logLevel = el("select", {});
  for (const [k, label] of [["all", "Everything"], ["warn", "Warnings and errors"], ["error", "Errors only"]]) logLevel.append(el("option", { value: k, textContent: label }));
  const logClear = el("button", { type: "button", textContent: "Clear" });
  const logCopy = el("button", { type: "button", textContent: "Copy" });
  const logList = el("div", { className: "dt-log" });
  const logView = el("div", { className: "dt-view", hidden: true }, el("div", { className: "dt-tools" }, logFilter, logLevel, logClear, logCopy), logList);
  const levelOk = (e) => state.level === "all" || (state.level === "warn" ? e.level === "warn" || e.level === "error" : e.level === "error");
  const logOk = (e) => levelOk(e) && (!state.logText || e.text.toLowerCase().includes(state.logText.toLowerCase()));
  const logLine = (e) => el("div", { className: "dt-line " + (e.level || "log") }, el("span", { className: "dt-time", textContent: time(e.time) }), el("span", { textContent: e.text }));
  function drawLog() {
    logList.textContent = "";
    const frag = document.createDocumentFragment();
    for (const e of state.logs.filter(logOk).slice(-1500)) frag.append(logLine(e));
    logList.append(frag);
    logList.scrollTop = logList.scrollHeight;
  }
  function addLogs(list) {
    const near = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
    for (const e of list) if (logOk(e)) logList.append(logLine(e));
    while (logList.childElementCount > 1500) logList.firstElementChild.remove();
    if (near) logList.scrollTop = logList.scrollHeight;
  }
  logFilter.addEventListener("input", () => ((state.logText = logFilter.value.trim()), drawLog()));
  logLevel.addEventListener("change", () => ((state.level = logLevel.value), drawLog()));

  const clearAll = async () => {
    try {
      await dt.clear();
    } catch {}
    state.requests = [];
    state.logs = [];
    state.selected = null;
    details.hidden = true;
    drawRequests();
    drawLog();
  };
  clearBtn.addEventListener("click", clearAll);
  logClear.addEventListener("click", clearAll);
  const copy = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Couldn't copy";
    }
    setTimeout(() => (btn.textContent = btn === copyBtn ? "Copy as JSON" : "Copy"), 1500);
  };
  copyBtn.addEventListener("click", () => copy(JSON.stringify(state.requests.filter((r) => matches(r, state.kind, state.text)), null, 2), copyBtn));
  logCopy.addEventListener("click", () => copy(state.logs.filter(logOk).map((e) => `${new Date(e.time).toISOString()} ${e.text}`).join("\n"), logCopy));

  // ---------- Status ----------
  const statusGrid = el("div", { className: "dt-status" });
  const statusView = el("div", { className: "dt-view", hidden: true }, statusGrid);
  const pair = (k, v) => [el("span", { className: "muted", textContent: k }), el("span", { textContent: v })];
  function drawStatus(s) {
    statusGrid.textContent = "";
    const rows = [];
    const dur = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`);
    if (web) {
      rows.push(["Backend running for", dur(s.uptime)], ["Node", s.node]);
      if (s.memory) rows.push(["Memory", `${formatBytes(s.memory.rss)} (JavaScript: ${formatBytes(s.memory.heapUsed)})`]);
      rows.push(["Kite sessions", String(s.sessions)], ["Kite accounts", String(s.accounts)]);
      if (s.scriptCache) rows.push(["Rewritten scripts cached", `${s.scriptCache.entries} (${formatBytes(s.scriptCache.bytes)})`]);
      if (s.compressedCache) rows.push(["Compressed pages cached", `${s.compressedCache.entries} (${formatBytes(s.compressedCache.bytes)})`]);
      rows.push(["Events kept", String(s.events)]);
    } else {
      rows.push(["Kite app", s.app || "?"], ["Running for", dur(s.uptime)], ["Chromium", s.versions?.chrome || "?"], ["Electron", s.versions?.electron || "?"], ["Node", s.versions?.node || "?"], ["System", s.platform]);
      if (s.memory) rows.push(["Memory", `${formatBytes(s.memory.kb * 1024)} in ${s.memory.processes} processes`]);
      rows.push(["Profile", s.profile.guest ? "Guest" : s.profile.name], ["Windows / tabs", `${s.windows} / ${s.tabs}`], ["Downloads", String(s.downloads)]);
      if (s.sync) rows.push(["Sync", s.sync.linked ? `${s.sync.user} at ${s.sync.backend}${s.sync.error ? " — " + s.sync.error : ""}` : "not linked"]);
      rows.push(["Events kept", String(s.events)]);
    }
    for (const [k, v] of rows) statusGrid.append(...pair(k, v));
  }

  // ---------- Switches (Kite Web) ----------
  const switchView = el("div", { className: "dt-view", hidden: true });
  async function drawSwitches() {
    let s, parts;
    try {
      const st = await dt.status();
      s = st.settings;
      parts = st.parts || {};
    } catch (err) {
      switchView.textContent = err.message;
      return;
    }
    switchView.textContent = "";
    const msg = el("p", { className: "muted", textContent: "Changes apply to pages loaded from now on: reload the tab you're testing. They last until the backend restarts (kite-secrets.bat sets them at start)." });
    const save = async (changes) => {
      try {
        s = await dt.settings(changes);
        msg.textContent = "Saved. Reload the tab you're testing.";
      } catch (err) {
        msg.textContent = err.message;
      }
    };
    const toggle = (label, hint, checked, onChange) => {
      const c = el("input", { type: "checkbox", checked });
      c.addEventListener("change", () => onChange(c.checked));
      return el("label", { className: "set-row" }, el("span", {}, el("span", { textContent: label }), hint ? el("small", { textContent: hint }) : null), c);
    };
    const section = (title, ...rows) => el("section", {}, el("h2", { textContent: title }), ...rows);
    switchView.append(
      el("div", { className: "settings" },
        section("Backend",
          toggle("Rewrite sites' scripts", "Kite renames location, top… inside scripts so pages see their real address. Off = KITE_JS_REWRITE=0.", s.jsRewrite, (v) => save({ jsRewrite: v })),
          toggle("Video log", "Log every YouTube video chunk ([video] lines). Same as KITE_MEDIA_LOG=1.", s.mediaLog, (v) => save({ mediaLog: v })),
          toggle("YouTube: hide protected-video (DRM) support inside Kite Web", "YouTube's full page checks for DRM as it starts; on Edge that reaches PlayReady's hardware video path, a suspect for the crash inside frames. Ordinary videos don't need it. Off = KITE_YOUTUBE_DRM=1.", s.youtubeHideDrm !== false, (v) => save({ youtubeHideDrm: v })),
          toggle("Asset log", "Log every file a page loads: [asset] lines for what the backend served, [page asset] lines for what the browser did with them (cache, failures, timing, video player events). Busy: switch it on, reload the tab, look. Same as KITE_ASSET_LOG=1.", Boolean(s.assetLog), (v) => save({ assetLog: v })),
          toggle("YouTube: play videos with YouTube's embedded player", "Kite's video page instead of the full watch page, which can crash inside Kite Web or stop after a minute. Off = KITE_YOUTUBE_EMBED=0.", s.youtubeEmbed !== false, (v) => save({ youtubeEmbed: v }))),
        section("Kite's page script (ticked = on)",
          ...Object.entries(parts).map(([k, desc]) =>
            toggle(k, String(desc), !s.clientOff.includes(k), (on) => {
              const off = new Set(s.clientOff);
              if (on) off.delete(k);
              else off.add(k);
              save({ clientOff: [...off] });
            })))),
      msg);
  }

  // ---------- Search (Kite Web: the crawler) ----------
  const searchView = el("div", { className: "dt-view", hidden: true });
  const searchInfo = el("div", { className: "dt-status" });
  const searchMsg = el("p", { className: "muted" });
  const recentList = el("div", { className: "dt-log" });
  const addUrl = el("input", { type: "url", placeholder: "https://a-site-to-add.example/", spellcheck: false });
  const addForm = el("form", { className: "dt-tools" }, addUrl, el("button", { type: "submit", textContent: "Add to the crawl" }));
  const pauseCrawl = el("button", { type: "button", textContent: "Pause crawling" });
  searchView.append(el("div", { className: "dt-tools" }, pauseCrawl), searchInfo, addForm, searchMsg, el("h3", { textContent: "Just read" }), recentList);
  let crawlPaused = false;
  async function searchAction(body) {
    try {
      drawSearch(await dt.search(body));
      if (body) searchMsg.textContent = body.action === "add" ? "Added: KiteBot reads it next." : "";
    } catch (err) {
      searchMsg.textContent = err.message;
    }
  }
  pauseCrawl.addEventListener("click", () => searchAction({ action: crawlPaused ? "resume" : "pause" }));
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (addUrl.value.trim()) searchAction({ action: "add", url: addUrl.value.trim() }).then(() => (addUrl.value = ""));
  });
  function drawSearch(s) {
    const c = s.crawler || {};
    crawlPaused = Boolean(c.paused) || !c.running;
    pauseCrawl.textContent = crawlPaused ? "Start crawling" : "Pause crawling";
    searchInfo.textContent = "";
    const rows = [
      ["Pages in Kite Search", `${Number(s.pages).toLocaleString()} of ${Number(s.maxPages).toLocaleString()} (${Number(s.sites).toLocaleString()} sites, ${Number(s.terms).toLocaleString()} words)`],
      ["KiteBot", c.running ? (c.paused ? "paused" : `crawling, ${c.active} at once`) : "not crawling (KITE_SEARCH_CRAWL=0)"],
      ["Waiting to be read", `${Number(c.queued || 0).toLocaleString()} pages on ${Number(c.sitesQueued || 0).toLocaleString()} sites`],
      ["Read since start", `${c.crawled || 0} (${c.indexed || 0} added, ${c.skipped || 0} skipped, ${c.failed || 0} failed)`],
      ["Searches since start", String(s.searches || 0)],
      ["Learning from browsing", s.learn ? "on (KITE_SEARCH_LEARN=1)" : "off"],
    ];
    for (const [k, v] of rows) searchInfo.append(...pair(k, v));
    recentList.textContent = "";
    for (const r of c.recent || []) {
      const bad = /failed|HTTP [45]/.test(r.result);
      recentList.append(el("div", { className: "dt-line" + (bad ? " warn" : "") },
        el("span", { className: "dt-time", textContent: time(r.time) }),
        el("span", { textContent: `${r.result}  ${r.url}${r.title ? "  — " + r.title : ""}${r.error ? "  (" + r.error + ")" : ""}` })));
    }
  }
  const refreshSearch = () => searchAction(null);

  // ---------- tabs and polling ----------
  const views = { requests: reqView, log: logView, status: statusView, ...(dt.search ? { search: searchView } : {}), ...(dt.settings ? { switches: switchView } : {}) };
  const names = { requests: "Requests", log: "Log", status: "Status", search: "Search", switches: "Switches" };
  const tabButtons = {};
  for (const k of Object.keys(views)) {
    const b = el("button", { type: "button", className: "dt-tab", textContent: names[k], role: "tab" });
    b.addEventListener("click", () => show(k));
    tabButtons[k] = b;
    tabsEl.append(b);
    body.append(views[k]);
  }
  async function show(k) {
    state.view = k;
    for (const [n, v] of Object.entries(views)) {
      v.hidden = n !== k;
      tabButtons[n].classList.toggle("active", n === k);
      tabButtons[n].setAttribute("aria-selected", String(n === k));
    }
    if (k === "status") refreshStatus();
    if (k === "switches") drawSwitches();
    if (k === "search") refreshSearch();
  }
  async function refreshStatus() {
    try {
      drawStatus(await dt.status());
    } catch (err) {
      statusGrid.textContent = err.message;
    }
  }

  async function poll() {
    if (!alive()) return;
    if (!state.paused && !root.hidden) {
      try {
        const r = await dt.events(state.since);
        // The backend restarted (ids start again): start over.
        if (r.next < state.since) {
          state.since = 0;
          state.requests = [];
          state.logs = [];
          drawRequests();
          drawLog();
        } else {
          state.since = r.next;
          const reqs = r.events.filter((e) => e.type === "request");
          // The app's permission events go in the log too.
          const logs = r.events.filter((e) => e.type !== "request").map((e) => (e.type === "log" ? e : { ...e, level: "log", text: `[permission ${e.answer}] ${e.origin}: ${e.text}` }));
          state.requests.push(...reqs);
          state.logs.push(...logs);
          if (state.requests.length > MAX_KEPT) state.requests.splice(0, state.requests.length - MAX_KEPT);
          if (state.logs.length > MAX_KEPT) state.logs.splice(0, state.logs.length - MAX_KEPT);
          if (reqs.length) addRequests(reqs);
          if (logs.length) addLogs(logs);
        }
        note.textContent = web ? "Everything going through your Kite backend, from every browser using it." : "Everything this profile's tabs are doing. F12 opens Chromium's developer tools for one page.";
      } catch (err) {
        note.textContent = `Couldn't get events: ${err.message}`;
      }
      if (state.view === "status") refreshStatus();
      if (state.view === "search") refreshSearch();
    }
    if (alive()) setTimeout(poll, POLL_MS);
  }

  (async () => {
    let access;
    try {
      access = await dt.check();
    } catch (err) {
      access = { allowed: false, error: err.message };
    }
    if (!alive()) return;
    if (!access.allowed) {
      tabsEl.hidden = true;
      body.hidden = true;
      note.textContent = "";
      note.append(
        access.error
          ? `Couldn't reach the Kite backend: ${access.error}`
          : !access.configured
            ? "Kite DevTools is off on this backend. It shows everyone's browsing through the backend, so you choose who may open it: add  set KITE_DEVTOOLS_USERS=yourname  to kite-secrets.bat and restart the backend."
            : access.user
              ? `Your Kite account (${access.user}) isn't allowed to open Kite DevTools. Accounts listed in KITE_DEVTOOLS_USERS on the backend can.`
              : "Sign in to your Kite account (👤 in the toolbar) to open Kite DevTools."
      );
      return;
    }
    show("requests");
    poll();
  })();

  return { refresh: () => null };
}
