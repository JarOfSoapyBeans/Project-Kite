// A small stand-in for Electron, enough to run main.js in plain Node for tests.
const { EventEmitter } = require("node:events");

const state = { schemes: [], handlers: {}, ipcHandle: {}, ipcOn: {}, windows: [], views: [], sessions: {}, menu: undefined, external: [] };

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = "";
    this.sent = [];
    this.loaded = [];
    this.focused = 0;
    this.closed = false;
    const wc = this;
    this.mainFrame = { parent: null, get url() { return wc.url; } };
    this.navigationHistory = { canGoBack: () => true, canGoForward: () => false, goBack: () => this.loaded.push("<back>"), goForward: () => {} };
  }
  send(channel, data) { this.sent.push([channel, data]); }
  focus() { this.focused++; }
  loadURL(url) { this.loaded.push(url); this.url = url; return Promise.resolve(); }
  getURL() { return this.url; }
  getTitle() { return "Title of " + this.url; }
  reload() { this.loaded.push("<reload>"); }
  stop() {}
  close() { this.closed = true; }
  toggleDevTools() { this.devtools = !this.devtools; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
}

class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.children = [];
    this.contentView = { addChildView: (v) => this.children.push(v), removeChildView: (v) => (this.children = this.children.filter((c) => c !== v)) };
    state.windows.push(this);
  }
  loadURL(url) { this.webContents.url = url; return Promise.resolve(); }
  getContentBounds() { return { x: 0, y: 0, width: 1000, height: 700 }; }
  isDestroyed() { return false; }
  isMinimized() { return false; }
  setFullScreen(v) { this.fullscreen = v; }
  focus() {}
  restore() {}
}

class WebContentsView {
  constructor(opts) {
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.visible = true;
    state.views.push(this);
  }
  setBounds(b) { this.bounds = b; }
  setVisible(v) { this.visible = v; }
}

function fakeSession(name) {
  return (state.sessions[name] ||= {
    name,
    protocol: { handle: (s, fn) => (state.handlers[name + ":" + s] = fn) },
    setPermissionRequestHandler(fn) { this.request = fn; },
    setPermissionCheckHandler(fn) { this.check = fn; },
  });
}

const appEvents = new EventEmitter();
module.exports = {
  __state: state,
  app: {
    userAgentFallback: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) kite-desktop/0.3.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36",
    getName: () => "kite-desktop",
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (n, fn) => appEvents.on(n, fn),
    emit: (...a) => appEvents.emit(...a),
    quit: () => (state.quit = true),
  },
  BrowserWindow,
  WebContentsView,
  ipcMain: { handle: (n, fn) => (state.ipcHandle[n] = fn), on: (n, fn) => (state.ipcOn[n] = fn) },
  protocol: { registerSchemesAsPrivileged: (s) => state.schemes.push(...s), handle: (s, fn) => (state.handlers["default:" + s] = fn) },
  net: { fetch: (url) => Promise.resolve({ fetched: url }) },
  session: { fromPartition: fakeSession },
  Menu: { setApplicationMenu: (m) => (state.menu = m), buildFromTemplate: (t) => ({ template: t }) },
  shell: { openExternal: (u) => state.external.push(u) },
};
