// The Kite app's platform layer: each tab is a real Chromium page (a
// WebContentsView in desktop/main.js), placed under this toolbar. Calls go
// through the bridge in desktop/preload.js (window.kiteDesktop).

const bridge = window.kiteDesktop;
let events = null;
let dataListener = null;

const platform = {
  kind: "desktop",
  features: {
    // Kite Web only
    accounts: false, cookies: false, popout: false, backendSettings: false,
    // the app
    siteInfo: true, permissions: true, find: true, zoom: true, print: true,
    downloads: true, profiles: true, windows: true, menu: true, appMenu: true, tabMenu: true, favicons: true,
  },

  start(ev) {
    events = ev;
    bridge.onEvent((e) => {
      switch (e.type) {
        case "page": return events.pageChanged(e.id, e.info || {});
        case "open": return events.openTab(e.url);
        case "search": return events.search(e.text);
        case "shortcut": return events.shortcut(e.name);
        case "navigate": return events.navigateRequest(e.id, e.input);
        case "find": return events.find(e.id, e.active, e.total);
        case "zoom": return events.zoom(e.id, e.percent);
        case "permission": return events.permission(e.request);
        case "permission-done": return events.permissionDone(e.id);
        case "downloads": return events.downloads(e.list || []);
        case "data": return dataListener && dataListener(e.name, e.value);
      }
    });
    // Tabs go under the toolbar: tell the app how tall it is, now and whenever
    // it changes (bars and panels open under it).
    const chrome = document.getElementById("chrome");
    const report = () => bridge.setInset(Math.ceil(chrome.getBoundingClientRect().height));
    new ResizeObserver(report).observe(chrome);
    report();
    // Websites are drawn by the app over this area; Kite's own pages are drawn here.
  },

  createView: (id) => bridge.createView(id),
  closeView: (id) => bridge.closeView(id),
  showView: (id) => bridge.showView(id),
  showNewTab: (id) => bridge.showNewTab(id),
  navigate: (id, url) => bridge.navigate(id, url),
  command: (id, cmd) => bridge.command(id, cmd),
  // The page may have the keyboard; Kite's toolbar needs it.
  focusUi: () => bridge.focusUi(),
  popout() {},
  startUrls: () => bridge.startUrls(),
  // History, bookmarks, settings...: kept in your profile's folder by the app
  // (guest windows: in memory), shared by the profile's windows.
  loadData: (name) => bridge.loadData(name),
  saveData: (name, value) => bridge.saveData(name, value),
  onDataChanged: (fn) => (dataListener = fn),
  // Syncing this profile with a Kite account (Settings).
  sync: {
    status: () => bridge.syncStatus(),
    link: (backend, code) => bridge.syncLink(backend, code),
    unlink: () => bridge.syncUnlink(),
    now: () => bridge.syncNow(),
  },

  // Kite DevTools: this profile's requests, page errors, crashes, downloads, sync.
  devtools: {
    check: async () => ({ allowed: true }),
    events: (since) => bridge.devtoolsEvents(since),
    status: () => bridge.devtoolsStatus(),
    clear: () => bridge.devtoolsClear(),
    settings: null, // the app has no switches: its tabs are real pages
  },

  find: (id, text, opts) => bridge.find(id, text, opts),
  stopFind: (id) => bridge.stopFind(id),
  zoom: (id, dir) => bridge.zoom(id, dir),
  savePdf: (id) => bridge.savePdf(id),
  siteInfo: (id) => bridge.siteInfo(id),
  clearSite: (id) => bridge.clearSite(id),
  resetPermissions: (id) => bridge.resetPermissions(id),
  answerPermission: (reqId, allow, remember) => bridge.answerPermission(reqId, allow, remember),
  listDownloads: () => bridge.listDownloads(),
  downloadAction: (id, cmd) => bridge.downloadAction(id, cmd),
  listProfiles: () => bridge.listProfiles(),
  addProfile: (name) => bridge.addProfile(name),
  renameProfile: (id, name) => bridge.renameProfile(id, name),
  removeProfile: (id) => bridge.removeProfile(id),
  openProfile: (id) => bridge.openProfile(id),
  newWindow: () => bridge.newWindow(),
  guestWindow: () => bridge.guestWindow(),
  tabMenu: (opts) => bridge.tabMenu(opts),
  appMenu: () => bridge.appMenu(),
};

export default platform;
