// The bridge between Kite's interface (kite://app/index.html) and main.js.
// Only these calls exist; the interface gets no other access to the computer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kiteDesktop", {
  createView: (id) => ipcRenderer.invoke("view:create", id),
  closeView: (id) => ipcRenderer.invoke("view:close", id),
  showView: (id) => ipcRenderer.invoke("view:show", id),
  navigate: (id, url) => ipcRenderer.invoke("view:navigate", id, url),
  showNewTab: (id) => ipcRenderer.invoke("view:newtab", id),
  command: (id, cmd) => ipcRenderer.invoke("view:command", id, cmd),
  setInset: (px) => ipcRenderer.invoke("ui:inset", px),
  focusUi: () => ipcRenderer.invoke("ui:focus"),
  onEvent: (fn) => ipcRenderer.on("kite:event", (_e, event) => fn(event)),
});
