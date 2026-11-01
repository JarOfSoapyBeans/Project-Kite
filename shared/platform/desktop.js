// The Kite app's platform layer: each tab is a real Chromium page (a
// WebContentsView in desktop/main.js), placed under this toolbar. Calls go
// through the bridge in desktop/preload.js (window.kiteDesktop).

const bridge = window.kiteDesktop;
let events = null;

const platform = {
  kind: "desktop",
  features: { accounts: false, cookies: false, popout: false, backendSettings: false },

  start(ev) {
    events = ev;
    bridge.onEvent((e) => {
      if (e.type === "page") events.pageChanged(e.id, e.info || {});
      else if (e.type === "open") events.openTab(e.url);
      else if (e.type === "shortcut") events.shortcut(e.name);
      else if (e.type === "navigate") events.navigateRequest(e.id, e.input);
    });
    // Tabs go under the toolbar: tell the app how tall it is, now and whenever it changes.
    const chrome = document.getElementById("chrome");
    const report = () => bridge.setInset(Math.ceil(chrome.getBoundingClientRect().height));
    new ResizeObserver(report).observe(chrome);
    report();
    document.getElementById("views").hidden = true; // pages are drawn by the app, not here
  },

  createView: (id) => bridge.createView(id),
  closeView: (id) => bridge.closeView(id),
  showView: (id) => bridge.showView(id),
  showNewTab: (id) => bridge.showNewTab(id),
  navigate: (id, url) => bridge.navigate(id, url),
  command: (id, cmd) => bridge.command(id, cmd),
  // The page may have the keyboard; the address bar needs it.
  focusUi: () => bridge.focusUi(),
  popout() {},
};

export default platform;
