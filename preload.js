// Ponte segura entre o app (HTML) e o processo principal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  // transmissão de tela
  onPickSource: (cb) => ipcRenderer.on("pick-source", (_e, sources) => cb(sources)),
  pickSource: (id) => ipcRenderer.send("source-picked", id),
  setShareOptions: (o) => ipcRenderer.send("share:opts", o),
  // memória de configs
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (o) => ipcRenderer.invoke("settings:set", o),
  // servidor embutido
  startServer: (port) => ipcRenderer.invoke("server:start", port),
  stopServer: () => ipcRenderer.invoke("server:stop"),
  // rede LAN
  lanInfo: () => ipcRenderer.invoke("lan:info"),
  lanListen: () => ipcRenderer.invoke("lan:listen"),
  lanProbe: (ip) => ipcRenderer.invoke("lan:probe", ip),
  lanStart: (o) => ipcRenderer.invoke("lan:start", o),
  lanStop: () => ipcRenderer.invoke("lan:stop"),
  lanElevate: (r) => ipcRenderer.invoke("lan:elevate", r),
  lanWrite: (u8) => ipcRenderer.send("lan:out", u8),
  onLanIn: (cb) => ipcRenderer.on("lan:in", (_e, d) => cb(d)),
  onLanStatus: (cb) => ipcRenderer.on("lan:status", (_e, d) => cb(d)),
  onLanResume: (cb) => ipcRenderer.on("lan:resume", (_e, d) => cb(d)),
  // auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on("update-available", (_e, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on("update-progress", (_e, p) => cb(p)),
  onUpdateReady: (cb) => ipcRenderer.on("update-ready", (_e, d) => cb(d)),
  onUpdateError: (cb) => ipcRenderer.on("update-error", (_e, d) => cb(d)),
  onUpdateStatus: (cb) => ipcRenderer.on("update-status", (_e, d) => cb(d)),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  applyUpdate: (dir) => ipcRenderer.invoke("update:apply", dir),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  ytTitle: (id) => ipcRenderer.invoke("yt:title", id),
  setThemeBg: (c) => ipcRenderer.send("theme:bg", c),
  setWindowMode: (o) => ipcRenderer.send("win:mode", o),
  appReady: () => ipcRenderer.send("app:ready"),
  musicResolve: (url) => ipcRenderer.invoke("music:resolve", url),
  musicSearch: (o) => ipcRenderer.invoke("music:search", o),
  musicKeyInfo: () => ipcRenderer.invoke("music:keyInfo"),
  musicTestKey: (k) => ipcRenderer.invoke("music:testKey", k),
  pcAudioAvailable: () => ipcRenderer.invoke("pcaudio:available"),
  pcAudioList: () => ipcRenderer.invoke("pcaudio:list"),
  pcAudioStart: (o) => ipcRenderer.invoke("pcaudio:start", o),
  pcAudioStop: (id) => ipcRenderer.invoke("pcaudio:stop", id),
  onPcAudioData: (cb) => ipcRenderer.on("pcaudio:data", (_e, id, d) => cb(id, d)),
  onPcAudioEnd: (cb) => ipcRenderer.on("pcaudio:end", (_e, d) => cb(d))
});
