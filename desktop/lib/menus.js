// Right-click menus (real system menus, so they show above the page), the menu
// on a tab, and Kite's own ⋮ menu. These only build the menu items; main.js
// shows them and does what was clicked.

const http = (u) => /^https?:/i.test(String(u || ""));
const short = (s, n = 30) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// params: Electron's context-menu details. act(name, value) does the work.
function pageMenu(params, { canGoBack, canGoForward, searchName }, act) {
  const items = [];
  const sep = () => items.length && items[items.length - 1].type !== "separator" && items.push({ type: "separator" });

  if (params.isEditable) {
    for (const s of (params.dictionarySuggestions || []).slice(0, 5)) {
      items.push({ label: s, click: () => act("replace-misspelling", s) });
    }
    if (params.misspelledWord) {
      items.push({ label: "Add to dictionary", click: () => act("add-to-dictionary", params.misspelledWord) });
      sep();
    }
    const f = params.editFlags || {};
    items.push(
      { label: "Undo", role: "undo", enabled: f.canUndo !== false },
      { label: "Redo", role: "redo", enabled: f.canRedo !== false },
      { type: "separator" },
      { label: "Cut", role: "cut", enabled: f.canCut !== false },
      { label: "Copy", role: "copy", enabled: f.canCopy !== false },
      { label: "Paste", role: "paste", enabled: f.canPaste !== false },
      { label: "Select all", role: "selectAll" }
    );
    sep();
  } else if (params.selectionText && params.selectionText.trim()) {
    const text = params.selectionText.trim();
    items.push(
      { label: "Copy", role: "copy" },
      { label: `Search ${searchName} for “${short(text)}”`, click: () => act("search", text) }
    );
    sep();
  }

  if (http(params.linkURL)) {
    items.push(
      { label: "Open link in new tab", click: () => act("open-tab", params.linkURL) },
      { label: "Open link in new window", click: () => act("open-window", params.linkURL) },
      { label: "Save link as…", click: () => act("download", params.linkURL) },
      { label: "Copy link address", click: () => act("copy", params.linkURL) }
    );
    sep();
  }

  if (params.mediaType === "image" && params.srcURL) {
    if (http(params.srcURL)) items.push({ label: "Open image in new tab", click: () => act("open-tab", params.srcURL) });
    items.push(
      { label: "Save image as…", click: () => act("download", params.srcURL) },
      { label: "Copy image", click: () => act("copy-image", { x: params.x, y: params.y }) },
      { label: "Copy image address", click: () => act("copy", params.srcURL) }
    );
    sep();
  } else if ((params.mediaType === "video" || params.mediaType === "audio") && http(params.srcURL)) {
    items.push(
      { label: `Open ${params.mediaType} in new tab`, click: () => act("open-tab", params.srcURL) },
      { label: `Save ${params.mediaType} as…`, click: () => act("download", params.srcURL) }
    );
    sep();
  }

  if (!params.isEditable && !params.linkURL && !params.selectionText && params.mediaType !== "image") {
    items.push(
      { label: "Back", enabled: Boolean(canGoBack), click: () => act("back") },
      { label: "Forward", enabled: Boolean(canGoForward), click: () => act("forward") },
      { label: "Reload", click: () => act("reload") },
      { type: "separator" },
      { label: "Save page as PDF…", click: () => act("pdf") },
      { label: "Print…", click: () => act("print") },
      { type: "separator" }
    );
    if (http(params.pageURL)) items.push({ label: "View page source", click: () => act("view-source", params.pageURL) });
  }
  items.push({ label: "Inspect", click: () => act("inspect", { x: params.x, y: params.y }) });
  return items;
}

// The menu on a tab. Resolves to what the interface should do.
function tabMenu({ canReopen, count }, choose) {
  return [
    { label: "New tab to the right", click: () => choose("new-tab-right") },
    { type: "separator" },
    { label: "Reload", click: () => choose("reload") },
    { label: "Duplicate", click: () => choose("duplicate") },
    { type: "separator" },
    { label: "Close", click: () => choose("close") },
    { label: "Close other tabs", enabled: count > 1, click: () => choose("close-others") },
    { label: "Close tabs to the right", enabled: count > 1, click: () => choose("close-right") },
    { label: "Reopen closed tab", enabled: Boolean(canReopen), click: () => choose("reopen-tab") },
  ];
}

// Kite's ⋮ menu.
function appMenu({ profiles, currentProfile }, choose) {
  return [
    { label: "New tab", accelerator: "CmdOrCtrl+T", click: () => choose("new-tab") },
    { label: "New window", accelerator: "CmdOrCtrl+N", click: () => choose("new-window") },
    { label: "New guest window", accelerator: "CmdOrCtrl+Shift+N", click: () => choose("guest-window") },
    {
      label: "Profiles",
      submenu: [
        ...profiles.map((p) => ({
          label: p.name + (p.id === currentProfile ? "  (this window)" : ""),
          click: () => choose("open-profile:" + p.id),
        })),
        { type: "separator" },
        { label: "Manage profiles…", click: () => choose("profiles") },
      ],
    },
    { type: "separator" },
    { label: "History", accelerator: "CmdOrCtrl+H", click: () => choose("history") },
    { label: "Bookmarks", accelerator: "CmdOrCtrl+Shift+O", click: () => choose("bookmarks") },
    { label: "Downloads", accelerator: "CmdOrCtrl+J", click: () => choose("downloads") },
    { type: "separator" },
    { label: "Zoom in", accelerator: "CmdOrCtrl+=", click: () => choose("zoom-in") },
    { label: "Zoom out", accelerator: "CmdOrCtrl+-", click: () => choose("zoom-out") },
    { label: "Actual size", accelerator: "CmdOrCtrl+0", click: () => choose("zoom-reset") },
    { type: "separator" },
    { label: "Find…", accelerator: "CmdOrCtrl+F", click: () => choose("find") },
    { label: "Print…", accelerator: "CmdOrCtrl+P", click: () => choose("print") },
    { label: "Save page as PDF…", click: () => choose("pdf") },
    { type: "separator" },
    { label: "Settings", click: () => choose("settings") },
    { label: "Kite DevTools", accelerator: "CmdOrCtrl+Shift+K", click: () => choose("kite-devtools") },
    { label: "Developer tools (this page)", accelerator: "F12", click: () => choose("devtools") },
    { type: "separator" },
    { label: "Exit", click: () => choose("exit") },
  ];
}

module.exports = { pageMenu, tabMenu, appMenu };
