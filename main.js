// Tátão — processo principal (Electron)
// Janela + captura de tela + memória de configs + servidor embutido + AUTO-UPDATE (GitHub Releases).
const { app, BrowserWindow, session, desktopCapturer, ipcMain, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");

// permite tocar música (YouTube) sem exigir clique a cada vez — essencial pra sincronizar entre todos
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win = null;
let peerServer = null;
let peerServerPort = null;

const CFG = path.join(app.getPath("userData"), "config.json");
function readCfg() { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch (_) { return {}; } }
function writeCfg(obj) { try { fs.writeFileSync(CFG, JSON.stringify(obj || {}, null, 2)); return true; } catch (_) { return false; } }

function lanIps() {
  const out = []; const ifs = os.networkInterfaces();
  for (const k in ifs) for (const a of ifs[k]) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

// ---------- servidor de sinalização embutido (tipo Radmin) ----------
function startPeerServer(port) {
  port = Number(port) || 9000;
  return new Promise((resolve) => {
    if (peerServer) { resolve({ ok: true, already: true, ips: lanIps(), port: peerServerPort }); return; }
    let settled = false; const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const { PeerServer } = require("peer");
      const srv = PeerServer({ port: port, host: "0.0.0.0", path: "/", key: "peerjs", proxied: false }, () => {
        peerServer = srv; peerServerPort = port; done({ ok: true, ips: lanIps(), port: port });
      });
      srv.on("error", (err) => done({ ok: false, error: (err && (err.code || err.message)) || String(err) }));
      setTimeout(() => { if (!settled) { peerServer = srv; peerServerPort = port; done({ ok: true, ips: lanIps(), port: port }); } }, 2500);
    } catch (e) { done({ ok: false, error: String((e && e.message) || e) }); }
  });
}
function stopPeerServer() { try { if (peerServer && peerServer.close) peerServer.close(); } catch (_) {} peerServer = null; peerServerPort = null; return { ok: true }; }

// ---------- auto-update via GitHub Releases ----------
function updateRepo() {
  // repo lido de um arquivo editável ao lado do app (resources/update.json): {"repo":"usuario/repositorio"}
  try { const j = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "update.json"), "utf8")); return (j.repo || "").trim(); } catch (_) { return ""; }
}
function semverGt(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number), pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x > y) return true; if (x < y) return false; }
  return false;
}
function ghGet(url, accept) {
  return new Promise((res, rej) => {
    const req = https.get(url, { headers: { "User-Agent": "Tatao-Updater", "Accept": accept || "application/vnd.github+json" } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); ghGet(r.headers.location, accept).then(res, rej); return; }
      let d = ""; r.on("data", (c) => d += c); r.on("end", () => res({ status: r.statusCode, body: d }));
    });
    req.on("error", rej); req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}
function ghDownload(url, dest, onProgress) {
  return new Promise((res, rej) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "Tatao-Updater", "Accept": "application/octet-stream" } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); file.close(); fs.unlink(dest, () => {}); ghDownload(r.headers.location, dest, onProgress).then(res, rej); return; }
      if (r.statusCode !== 200) { r.resume(); file.close(); rej(new Error("HTTP " + r.statusCode)); return; }
      const total = parseInt(r.headers["content-length"] || "0", 10); let got = 0;
      r.on("data", (c) => { got += c.length; if (total && onProgress) onProgress(got / total); });
      r.pipe(file); file.on("finish", () => file.close(() => res()));
    });
    req.on("error", (e) => { fs.unlink(dest, () => {}); rej(e); });
  });
}
function findExeDir(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop(); let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.toLowerCase() === "tatao.exe") return d;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return null;
}
function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }
function ghRedirect(url) {
  // pega só o endereço de redirecionamento (sem seguir), pra descobrir a tag mais nova
  return new Promise((res, rej) => {
    const req = https.get(url, { headers: { "User-Agent": "Tatao-Updater" } }, (r) => { r.resume(); res(r.headers.location || ""); });
    req.on("error", rej); req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

let updBusy = false;   // evita duas checagens/downloads ao mesmo tempo
let updReady = null;   // atualização já baixada e pronta
async function checkUpdate(manual) {
  if (updReady) { send("update-ready", updReady); return; }
  if (updBusy) { if (manual) send("update-status", { state: "busy" }); return; }
  const repo = updateRepo();
  if (manual) send("update-status", { state: "checking" });
  if (!repo) { if (manual) send("update-status", { state: "disabled" }); return; }
  if (process.platform !== "win32") { if (manual) send("update-status", { state: "unsupported" }); return; }
  updBusy = true;
  try {
    let tag = null, assetUrl = null;
    // 1) link público do GitHub (sem limite de consultas): /releases/latest redireciona pra /releases/tag/<tag>
    try {
      const loc = await ghRedirect("https://github.com/" + repo + "/releases/latest");
      if (loc && loc.indexOf("/releases/tag/") >= 0) {
        tag = decodeURIComponent(loc.split("/releases/tag/")[1].split(/[?#]/)[0]);
        assetUrl = "https://github.com/" + repo + "/releases/download/" + encodeURIComponent(tag) + "/Tatao-Windows.zip";
      }
    } catch (_) {}
    // 2) reserva: API do GitHub (tem limite de 60 consultas/hora por internet)
    if (!tag) {
      const r = await ghGet("https://api.github.com/repos/" + repo + "/releases/latest");
      if (r.status !== 200) { if (manual) send("update-status", { state: r.status === 404 ? "none" : "error", version: app.getVersion() }); return; }
      const rel = JSON.parse(r.body);
      const asset = rel && (rel.assets || []).find((a) => /\.zip$/i.test(a.name));
      if (rel && rel.tag_name && asset) { tag = rel.tag_name; assetUrl = asset.browser_download_url; }
    }
    if (!tag || !assetUrl || !semverGt(tag, app.getVersion())) { if (manual) send("update-status", { state: "none", version: app.getVersion() }); return; }
    send("update-available", { version: tag });
    const tmp = path.join(app.getPath("temp"), "tatao-update");
    process.noAsar = true; // pasta antiga pode conter app.asar
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} finally { process.noAsar = false; }
    fs.mkdirSync(tmp, { recursive: true });
    const zipPath = path.join(tmp, "update.zip");
    await ghDownload(assetUrl, zipPath, (p) => send("update-progress", p));
    const outDir = path.join(tmp, "extracted");
    const extract = require("extract-zip");
    // o Electron trata arquivos .asar como pastas; desliga isso enquanto extrai o pacote novo (que contém app.asar)
    let appDir = null;
    process.noAsar = true;
    try { await extract(zipPath, { dir: outDir }); appDir = findExeDir(outDir); }
    finally { process.noAsar = false; }
    if (!appDir) { send("update-error", { msg: "pacote inválido", url: "https://github.com/" + repo + "/releases/latest" }); return; }
    updReady = { version: tag, dir: appDir };
    send("update-ready", updReady);
  } catch (e) {
    send("update-error", { msg: String((e && e.message) || e), url: "https://github.com/" + repo + "/releases/latest" });
  } finally {
    updBusy = false;
  }
}

function applyUpdate(newDir) {
  try {
    const installDir = path.dirname(app.getPath("exe"));
    const exe = app.getPath("exe");
    const bat = path.join(app.getPath("temp"), "tatao-apply.cmd");
    const log = path.join(app.getPath("temp"), "tatao-update.log");
    const script = [
      "@echo off",
      "chcp 65001 >nul",
      // espera o Tátão fechar (ping funciona mesmo sem janela de console; timeout não)
      "ping -n 4 127.0.0.1 >nul",
      // copia a versão nova por cima; o próprio robocopy tenta de novo se algum arquivo ainda estiver em uso
      'robocopy "' + newDir + '" "' + installDir + '" /E /IS /IT /R:10 /W:2 /NP /LOG:"' + log + '"',
      'start "" "' + exe + '"',
      "exit"
    ].join("\r\n");
    fs.writeFileSync(bat, script, "utf8");
    spawn("cmd.exe", ["/c", bat], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(() => app.quit(), 400);
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ---------- janela ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 720, minHeight: 520,
    backgroundColor: "#1a1b1e", autoHideMenuBar: true, title: "Tátão",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "sala-lan.html"));

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(true));
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false })
      .then((sources) => {
        send("pick-source", sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
        ipcMain.once("source-picked", (_e, id) => {
          if (!id) { try { callback(); } catch (_) {} return; }
          const chosen = sources.find((s) => s.id === id) || sources[0];
          try { callback({ video: chosen, audio: "loopback" }); } catch (_) { try { callback({ video: chosen }); } catch (__) {} }
        });
      }).catch(() => { try { callback(); } catch (_) {} });
  });

  win.webContents.once("did-finish-load", () => { setTimeout(checkUpdate, 4000); });
  setInterval(checkUpdate, 30 * 60 * 1000); // re-checa a cada 30 min
  win.on("closed", () => { win = null; });
}

// ---------- IPC ----------
ipcMain.handle("settings:get", () => readCfg());
ipcMain.handle("settings:set", (_e, obj) => writeCfg(obj));
ipcMain.handle("server:start", (_e, port) => startPeerServer(port));
ipcMain.handle("server:stop", () => stopPeerServer());
ipcMain.handle("update:check", () => checkUpdate(true));
ipcMain.handle("update:apply", (_e, dir) => applyUpdate(dir));
ipcMain.handle("open:external", (_e, url) => { try { shell.openExternal(url); } catch (_) {} });
ipcMain.handle("yt:title", (_e, id) => new Promise((resolve) => {
  try {
    https.get("https://www.youtube.com/oembed?format=json&url=https://youtu.be/" + encodeURIComponent(String(id)), { headers: { "User-Agent": "Tatao" } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); resolve(""); return; }
      let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { resolve((JSON.parse(d).title) || ""); } catch (_) { resolve(""); } });
    }).on("error", () => resolve(""));
  } catch (_) { resolve(""); }
}));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", () => { stopPeerServer(); });
}
