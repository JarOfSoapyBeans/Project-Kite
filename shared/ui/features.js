// Browser features beyond tabs and the address bar: the padlock and site info,
// "Allow camera?" questions, find in page, zoom, downloads, profiles, Kite's ⋮
// menu and the menu on a tab. Each shows only where the platform has it
// (platform.features); today that's the Kite app.
//
// In the app, pages are drawn over Kite's interface, so everything here lives in
// the toolbar area (#chrome), which grows and pushes the page down.

import { searchUrl } from "./lib/omnibox.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

export function initFeatures(kite) {
  const { platform } = kite;
  const has = (f) => Boolean(platform.features[f]);

  // ---------- panels under the toolbar (one at a time) ----------

  const panels = ["downloads-panel", "site-panel", "profile-panel"].map($);
  function openPanel(panel, open = panel.hidden) {
    for (const p of panels) p.hidden = p === panel ? !open : true;
    return open;
  }
  for (const p of panels) p.querySelector("[data-close]").addEventListener("click", () => (p.hidden = true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") for (const p of panels) p.hidden = true;
  });

  // ---------- padlock and site info ----------

  const siteBtn = $("site");
  const SECURITY = {
    secure: { icon: "\u{1F512}", label: "", text: "Connection is secure. What you send to this site is private." },
    insecure: { icon: "⚠", label: "Not secure", text: "Connection is not secure. Don't enter passwords or card details on this site." },
    error: { icon: "⚠", label: "", text: "This page couldn't load." },
    kite: { icon: "ⓘ", label: "", text: "This is a Kite page." },
  };
  function showSecurity(tab) {
    if (!has("siteInfo")) return;
    const s = SECURITY[(tab && tab.security) || "kite"] || SECURITY.kite;
    siteBtn.textContent = s.label ? `${s.icon} ${s.label}` : s.icon;
    siteBtn.className = (tab && tab.security) || "kite";
  }
  const PERMISSION_NAMES = {
    camera: "Camera", microphone: "Microphone", geolocation: "Location", notifications: "Notifications",
    midi: "MIDI devices", midiSysex: "MIDI device control", "clipboard-read": "Clipboard",
    "idle-detection": "Your activity", "window-management": "Window management", "storage-access": "Embedded cookies",
    "top-level-storage-access": "Embedded cookies", "speaker-selection": "Speakers",
  };
  function renderSite(info) {
    $("site-origin").textContent = (info && info.origin) || "Kite";
    const s = SECURITY[(info && info.security) || "kite"] || SECURITY.kite;
    $("site-security").textContent = s.text;
    const list = $("site-permissions");
    list.textContent = "";
    const perms = Object.entries((info && info.permissions) || {});
    for (const [k, v] of perms) {
      list.append(el("li", {}, el("span", { className: "name", textContent: PERMISSION_NAMES[k] || k }), el("span", { className: "sub", textContent: v === "allow" ? "Allowed" : "Blocked" })));
    }
    if (!perms.length && info && info.origin) list.append(el("li", {}, el("span", { className: "sub", textContent: "No permissions given or refused for this site." })));
    $("site-reset").hidden = !perms.length;
    $("site-clear").hidden = !(info && info.origin);
  }
  if (has("siteInfo")) {
    siteBtn.addEventListener("click", async () => {
      const tab = kite.activeTab();
      if (!tab || !openPanel($("site-panel"))) return;
      renderSite(await platform.siteInfo(tab.id));
    });
    $("site-reset").addEventListener("click", async () => {
      const tab = kite.activeTab();
      if (tab) renderSite(await platform.resetPermissions(tab.id));
    });
    $("site-clear").addEventListener("click", async () => {
      const tab = kite.activeTab();
      if (!tab) return;
      await platform.clearSite(tab.id);
      $("site-panel").hidden = true;
      platform.command(tab.id, "reload");
    });
  }

  // ---------- "Allow camera?" ----------

  const questions = []; // { id, tabId, origin, text }
  function showQuestion() {
    const tab = kite.activeTab();
    const q = tab && questions.find((x) => x.tabId === tab.id);
    $("permission-bar").hidden = !q;
    if (!q) return;
    let host = q.origin;
    try {
      host = new URL(q.origin).host;
    } catch {}
    $("permission-text").textContent = `${host} wants to ${q.text}`;
  }
  function answer(allow, remember) {
    const tab = kite.activeTab();
    const q = tab && questions.find((x) => x.tabId === tab.id);
    if (q) platform.answerPermission(q.id, allow, remember);
  }
  if (has("permissions")) {
    $("permission-once").addEventListener("click", () => answer(true, false));
    $("permission-always").addEventListener("click", () => answer(true, true));
    $("permission-never").addEventListener("click", () => answer(false, true));
    $("permission-dismiss").addEventListener("click", () => answer(false, false));
  }

  // ---------- find in page ----------

  const findBar = $("find-bar");
  const findText = $("find-text");
  let findTab = null;
  function openFind() {
    const tab = kite.activeTab();
    if (!has("find") || !tab || !tab.url) return;
    findTab = tab.id;
    findBar.hidden = false;
    kite.focusUi();
    findText.focus();
    findText.select();
    if (findText.value) platform.find(tab.id, findText.value, {});
  }
  function closeFind() {
    if (findTab !== null) platform.stopFind(findTab);
    findTab = null;
    findBar.hidden = true;
    $("find-count").textContent = "";
  }
  if (has("find")) {
    findText.addEventListener("input", () => {
      if (findTab === null) return;
      if (!findText.value) $("find-count").textContent = "";
      platform.find(findTab, findText.value, {});
    });
    findBar.addEventListener("submit", (e) => {
      e.preventDefault();
      if (findTab !== null && findText.value) platform.find(findTab, findText.value, { findNext: true, forward: true });
    });
    findText.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeFind();
      else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        if (findTab !== null && findText.value) platform.find(findTab, findText.value, { findNext: true, forward: false });
      }
    });
    $("find-prev").addEventListener("click", () => findTab !== null && findText.value && platform.find(findTab, findText.value, { findNext: true, forward: false }));
    $("find-close").addEventListener("click", closeFind);
  }

  // ---------- zoom ----------

  const zoomBadge = $("zoom-badge");
  function showZoom(tab) {
    const z = (tab && tab.zoom) || 100;
    zoomBadge.hidden = !has("zoom") || z === 100;
    zoomBadge.textContent = z + "%";
  }
  const zoom = (dir) => has("zoom") && kite.activeTab() && platform.zoom(kite.activeTab().id, dir);
  zoomBadge.addEventListener("click", () => zoom("reset"));

  // ---------- downloads ----------

  const seenDownloads = new Set();
  const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? Math.round(n / 1e3) + " KB" : n + " B");
  function renderDownloads(list) {
    const ul = $("downloads-list");
    ul.textContent = "";
    if (!list.length) ul.append(el("li", {}, el("span", { className: "sub", textContent: "Files you download appear here." })));
    let active = 0;
    let fresh = false;
    for (const d of list) {
      if (!seenDownloads.has(d.id)) (fresh = true), seenDownloads.add(d.id);
      const going = d.state === "progressing";
      if (going) active++;
      const status = going
        ? (d.paused ? "Paused • " : "") + (d.total ? `${size(d.received)} of ${size(d.total)}` : size(d.received))
        : { completed: size(d.total || d.received), cancelled: "Cancelled", interrupted: "Failed" }[d.state] || d.state;
      const info = el("div", { className: "name" }, el("div", { textContent: d.filename }), el("div", { className: "sub", textContent: status }));
      if (going && d.total) info.append(el("div", { className: "progress" }, el("div", { style: `width:${Math.round((100 * d.received) / d.total)}%` })));
      const btn = (label, cmd) => el("button", { type: "button", textContent: label, onclick: () => platform.downloadAction(d.id, cmd) });
      const li = el("li", {}, info);
      if (going) li.append(d.paused ? btn("Resume", "resume") : btn("Pause", "pause"), btn("Cancel", "cancel"));
      if (d.state === "completed") li.append(btn("Open", "open"), btn("Show in folder", "show"));
      li.append(el("button", { type: "button", className: "x", title: "Remove from list", textContent: "×", onclick: () => platform.downloadAction(d.id, "remove") }));
      ul.append(li);
    }
    const badge = $("downloads-badge");
    badge.hidden = !active;
    badge.textContent = String(active);
    if (fresh) openPanel($("downloads-panel"), true); // a new download: show it, like Chrome
  }
  async function toggleDownloads() {
    if (!has("downloads")) return;
    if (openPanel($("downloads-panel"))) renderDownloads(await platform.listDownloads());
  }
  if (has("downloads")) {
    $("downloads").addEventListener("click", toggleDownloads);
    platform.listDownloads().then((list) => {
      for (const d of list) seenDownloads.add(d.id);
      renderDownloads(list);
    });
  }

  // ---------- profiles ----------

  async function renderProfiles() {
    const { list, current } = await platform.listProfiles();
    $("profile").title = current.guest ? "Guest" : `Profile: ${current.name}`;
    const ul = $("profile-list");
    ul.textContent = "";
    for (const p of list) {
      const li = el("li", {}, el("span", { className: "name", textContent: p.name + (p.id === current.id ? "  (this window)" : "") }));
      li.append(el("button", { type: "button", textContent: "Open window", onclick: () => platform.openProfile(p.id) }));
      if (p.id !== "main") {
        const rename = el("button", { type: "button", textContent: "Rename" });
        rename.onclick = () => {
          const input = el("input", { value: p.name, maxLength: 40 });
          const save = el("button", { type: "button", textContent: "Save" });
          save.onclick = async () => (await platform.renameProfile(p.id, input.value), renderProfiles());
          li.replaceChildren(input, save);
          input.focus();
        };
        const remove = el("button", { type: "button", textContent: "Remove" });
        remove.onclick = () => {
          if (remove.dataset.sure) return platform.removeProfile(p.id).then(renderProfiles);
          remove.dataset.sure = "1";
          remove.textContent = "Remove it and its data?";
        };
        li.append(rename, remove);
      }
      ul.append(li);
    }
    if (current.guest) ul.append(el("li", {}, el("span", { className: "sub", textContent: "This is a guest window: nothing from it is kept after you close it." })));
  }
  if (has("profiles")) {
    $("profile").addEventListener("click", async () => {
      if (openPanel($("profile-panel"))) await renderProfiles();
    });
    $("profile-add").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("profile-name").value.trim();
      if (!name) return $("profile-name").focus();
      $("profile-name").value = "";
      await platform.addProfile(name);
      renderProfiles();
    });
    $("profile-guest").addEventListener("click", () => platform.guestWindow());
    platform.listProfiles().then(({ current }) => {
      $("profile").title = current.guest ? "Guest window" : `Profile: ${current.name}`;
      if (current.guest) $("profile").textContent = "\u{1F575}";
    });
  }

  // ---------- menus ----------

  // Things the ⋮ menu, the keyboard and page menus can ask for.
  const actions = {
    find: openFind,
    "zoom-in": () => zoom("in"),
    "zoom-out": () => zoom("out"),
    "zoom-reset": () => zoom("reset"),
    print: () => has("print") && kite.activeTab() && platform.command(kite.activeTab().id, "print"),
    pdf: () => has("print") && kite.activeTab() && platform.savePdf(kite.activeTab().id),
    downloads: toggleDownloads,
    profiles: () => has("profiles") && openPanel($("profile-panel"), true) && renderProfiles(),
    "new-window": () => has("windows") && platform.newWindow(),
    "guest-window": () => has("windows") && platform.guestWindow(),
    "new-tab": () => kite.createTab(),
  };
  if (has("appMenu")) {
    $("menu").addEventListener("click", async () => {
      const chosen = await platform.appMenu();
      if (chosen && actions[chosen]) actions[chosen]();
    });
  }

  // The menu on a tab (right-click).
  async function tabMenu(tab) {
    if (!has("tabMenu")) return;
    const tabs = kite.tabs();
    const chosen = await platform.tabMenu({ count: tabs.length, canReopen: kite.canReopen() });
    const i = tabs.indexOf(tab);
    if (chosen === "reload") platform.command(tab.id, "reload");
    else if (chosen === "duplicate") tab.url ? kite.createTab(tab.url) : kite.createTab();
    else if (chosen === "close") kite.closeTab(tab);
    else if (chosen === "close-others") tabs.filter((t) => t !== tab).forEach(kite.closeTab);
    else if (chosen === "close-right") tabs.slice(i + 1).forEach(kite.closeTab);
    else if (chosen === "reopen-tab") kite.reopen();
    else if (chosen === "new-tab-right") kite.createTab();
  }

  // ---------- what app.js tells us ----------

  return {
    actions,
    tabMenu,
    available: (name) => {
      const need = { find: "find", "zoom-in": "zoom", "zoom-out": "zoom", "zoom-reset": "zoom", print: "print", pdf: "print",
        downloads: "downloads", profiles: "profiles", "new-window": "windows", "guest-window": "windows", "new-tab": null }[name];
      return need === undefined ? false : need === null || has(need);
    },
    pageChanged(tab) {
      if (tab === kite.activeTab()) showSecurity(tab);
    },
    tabSelected(tab) {
      showSecurity(tab);
      showZoom(tab);
      showQuestion();
      if (findTab !== null && findTab !== tab.id) closeFind();
      $("site-panel").hidden = true;
    },
    tabClosed(tab) {
      if (findTab === tab.id) closeFind();
    },
    find(id, active, total) {
      if (id === findTab) $("find-count").textContent = findText.value ? `${total ? active : 0}/${total}` : "";
    },
    zoom(tab, percent) {
      tab.zoom = percent;
      if (tab === kite.activeTab()) showZoom(tab);
    },
    permission(request) {
      questions.push(request);
      showQuestion();
    },
    permissionDone(id) {
      const i = questions.findIndex((q) => q.id === id);
      if (i >= 0) questions.splice(i, 1);
      showQuestion();
    },
    downloads: renderDownloads,
    search: (text) => kite.createTab(searchUrl(text)),
  };
}
