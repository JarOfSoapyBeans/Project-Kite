// The bridge between Kite's interface (kite://app/index.html) and main.js.
// Only these calls exist; the interface gets no other access to the computer.
const { contextBridge, ipcRenderer } = require("electron");
const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld("kiteDesktop", {
  // tabs
  createView: call("view:create"),
  closeView: call("view:close"),
  showView: call("view:show"),
  navigate: call("view:navigate"),
  showNewTab: call("view:newtab"),
  command: call("view:command"), // back, forward, reload, stop, print
  find: call("view:find"),
  stopFind: call("view:stop-find"),
  zoom: call("view:zoom"), // in, out, reset
  savePdf: call("view:pdf"),
  devtools: call("view:devtools"),
  // the site in a tab
  siteInfo: call("site:info"),
  clearSite: call("site:clear"),
  resetPermissions: call("site:reset-permissions"),
  answerPermission: call("permission:answer"),
  // downloads
  listDownloads: call("downloads:list"),
  downloadAction: call("downloads:action"),
  // profiles and windows
  listProfiles: call("profiles:list"),
  addProfile: call("profiles:add"),
  renameProfile: call("profiles:rename"),
  removeProfile: call("profiles:remove"),
  openProfile: call("profiles:open"),
  newWindow: call("window:new"),
  guestWindow: call("window:guest"),
  startUrls: call("ui:start-urls"),
  // history, bookmarks, settings... for this window's profile
  loadData: call("data:load"),
  saveData: call("data:save"),
  // syncing this profile with a Kite account
  syncStatus: call("sync:status"),
  syncLink: call("sync:link"),
  syncUnlink: call("sync:unlink"),
  syncNow: call("sync:now"),
  // Kite DevTools (kite://devtools)
  devtoolsEvents: call("devtools:events"),
  devtoolsStatus: call("devtools:status"),
  devtoolsClear: call("devtools:clear"),
  // menus (real system menus; resolve to what was picked)
  tabMenu: call("menu:tab"),
  appMenu: call("menu:app"),
  // the interface itself
  setInset: call("ui:inset"),
  focusUi: call("ui:focus"),
  onEvent: (fn) => ipcRenderer.on("kite:event", (_e, event) => fn(event)),
});
