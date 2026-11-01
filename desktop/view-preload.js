// Runs in every tab. Websites get nothing from it; only Kite's own new tab page
// (kite://app/newtab.html) gets its search box hooked up to the address bar.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "kite:" && location.host === "app") {
  contextBridge.exposeInMainWorld("kiteNewTab", {
    navigate: (input) => ipcRenderer.send("newtab:navigate", String(input)),
  });
}
