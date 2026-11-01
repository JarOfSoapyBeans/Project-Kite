// A small stand-in for Electron, enough to run main.js in plain Node for tests.
const { EventEmitter } = require("node:events");

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "kite-fake-"));
const state = { schemes: [], handlers: {}, ipcHandle: {}, ipcOn: {}, windows: [], views: [], sessions: {}, menu: undefined, external: [],
  popups: [], clipboard: [], saved: [], paths: { userData: path.join(base, "userData"), downloads: path.join(base, "Downloads") } };
fs.mkdirSync(state.paths.downloads, { recursive: true });

let nextContentsId = 1;
class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextContentsId++;
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
  getZoomFactor() { return this.zoomFactor || 1; }
  setZoomFactor(z) { this.zoomFactor = z; }
  findInPage(text, opts) { (this.finds ||= []).push([text, opts]); }
  stopFindInPage(action) { (this.finds ||= []).push(["<stop>", action]); }
  print(opts, cb) { this.printed = true; cb && cb(true); }
  printToPDF() { return Promise.resolve(Buffer.from("%PDF-fake")); }
  downloadURL(u) { (this.downloads ||= []).push(u); }
  copyImageAt(x, y) { this.copiedImage = [x, y]; }
  inspectElement(x, y) { this.inspected = [x, y]; }
  replaceMisspelling(w) { this.replaced = w; }
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
  setTitle(t) { this.opts.title = t; }
  close() { this.destroyed = true; this.emit("closed"); }
  getContentBounds() { return { x: 0, y: 0, width: 1000, height: 700 }; }
  isDestroyed() { return Boolean(this.destroyed); }
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
  if (state.sessions[name]) return state.sessions[name];
  const s = new EventEmitter();
  Object.assign(s, {
    name,
    cleared: [],
    protocol: { handle: (sc, fn) => (state.handlers[name + ":" + sc] = fn) },
    setPermissionRequestHandler(fn) { this.request = fn; },
    setPermissionCheckHandler(fn) { this.check = fn; },
    clearStorageData(opts) { this.cleared.push(opts || "all"); return Promise.resolve(); },
    addWordToSpellCheckerDictionary(w) { (this.words ||= []).push(w); },
    webRequest: {
      listeners: {},
      onSendHeaders(fn) { this.listeners.sendHeaders = fn; },
      onCompleted(fn) { this.listeners.completed = fn; },
      onErrorOccurred(fn) { this.listeners.error = fn; },
    },
  });
  return (state.sessions[name] = s);
}

const appEvents = new EventEmitter();
module.exports = {
  __state: state,
  app: {
    userAgentFallback: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) kite-desktop/0.3.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36",
    getName: () => "kite-desktop",
    getVersion: () => "0.3.0",
    getAppMetrics: () => [{ memory: { workingSetSize: 1000 } }, { memory: { workingSetSize: 2000 } }],
    getPath: (n) => state.paths[n],
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
  Menu: {
    setApplicationMenu: (m) => (state.menu = m),
    buildFromTemplate: (t) => ({ template: t, popup(opts) { state.popups.push({ template: t, opts }); } }),
  },
  shell: { openExternal: (u) => state.external.push(u), openPath: (p) => state.external.push("open:" + p), showItemInFolder: (p) => state.external.push("show:" + p) },
  clipboard: { writeText: (t) => state.clipboard.push(t) },
  dialog: { showSaveDialog: (_w, o) => Promise.resolve({ canceled: false, filePath: path.join(state.paths.downloads, path.basename(o.defaultPath)) }) },
};
