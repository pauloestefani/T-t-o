// Ponte segura entre o app (HTML) e o processo principal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  // seletor de tela/janela
  onPickSource: (cb) => ipcRenderer.on("pick-source", (_e, sources) => cb(sources)),
  pickSource: (id) => ipcRenderer.send("source-picked", id),
  // memória de configs
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (o) => ipcRenderer.invoke("settings:set", o),
  // servidor embutido
  startServer: (port) => ipcRenderer.invoke("server:start", port),
  stopServer: () => ipcRenderer.invoke("server:stop"),
  // auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on("update-available", (_e, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on("update-progress", (_e, p) => cb(p)),
  onUpdateReady: (cb) => ipcRenderer.on("update-ready", (_e, d) => cb(d)),
  onUpdateError: (cb) => ipcRenderer.on("update-error", (_e, d) => cb(d)),
  onUpdateStatus: (cb) => ipcRenderer.on("update-status", (_e, d) => cb(d)),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  applyUpdate: (dir) => ipcRenderer.invoke("update:apply", dir),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  ytTitle: (id) => ipcRenderer.invoke("yt:title", id)
});
