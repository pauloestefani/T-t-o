// Tátão — processo principal (Electron)
// Janela + captura de tela + memória de configs + servidor embutido + AUTO-UPDATE (GitHub Releases).
const { app, BrowserWindow, session, desktopCapturer, ipcMain, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const net = require("net");
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

// ---------- Rede LAN: detectar redes virtuais (Radmin, ZeroTier, Tailscale, Hamachi) ----------
function classifyNet(name, ip) {
  const n = String(name).toLowerCase();
  const p = ip.split(".").map(Number);
  if (n.includes("tataolan")) return "tatao";
  if (n.includes("radmin") || p[0] === 26) return "radmin";
  if (n.includes("zerotier")) return "zerotier";
  if (n.includes("tailscale") || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)) return "tailscale";
  if (n.includes("hamachi") || p[0] === 25) return "hamachi";
  if (n.includes("wireguard") || n.includes("wintun")) return "wireguard";
  return "local";
}
function lanInfo() {
  const out = []; const ifs = os.networkInterfaces();
  for (const name in ifs) for (const a of ifs[name]) {
    if (a.family !== "IPv4" || a.internal) continue;
    if (/^169\.254\./.test(a.address)) continue; // endereço automático sem rede
    out.push({ name: name, ip: a.address, kind: classifyNet(name, a.address) });
  }
  // redes virtuais primeiro
  out.sort((x, y) => (x.kind === "local") - (y.kind === "local"));
  return out;
}
// "sonda" do Tátão: cada app escuta numa porta; o teste de conexão tenta abrir essa porta no PC do amigo pela rede virtual
const PROBE_PORT = 47999;
let probeSrv = null;
function startProbe() {
  if (probeSrv) return { ok: true };
  try {
    probeSrv = net.createServer((s) => { try { s.end("TATAO " + app.getVersion() + "\n"); } catch (_) {} });
    probeSrv.on("error", () => { probeSrv = null; });
    probeSrv.listen(PROBE_PORT, "0.0.0.0");
    return { ok: true };
  } catch (_) { probeSrv = null; return { ok: false }; }
}
function pingIp(ip) {
  return new Promise((res) => {
    const args = process.platform === "win32" ? ["-n", "1", "-w", "1500", ip] : ["-c", "1", "-W", "2", ip];
    let out = "", p;
    try { p = spawn("ping", args, { windowsHide: true }); } catch (_) { res({ ok: false, method: "ping" }); return; }
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} }, 4000);
    p.stdout.on("data", (d) => out += d);
    p.on("error", () => { clearTimeout(timer); res({ ok: false, method: "ping" }); });
    p.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/[=<]\s*(\d+)\s*ms/i);
      res({ ok: /ttl=/i.test(out), ms: m ? parseInt(m[1], 10) : null, method: "ping" });
    });
  });
}
function lanProbe(ip) {
  ip = String(ip || "");
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return Promise.resolve({ ok: false, error: "ip inválido" });
  return new Promise((res) => {
    const t0 = Date.now(); let done = false;
    const s = net.connect({ host: ip, port: PROBE_PORT });
    const fin = (r) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} res(r); };
    s.setTimeout(2500, () => fin(null));
    s.on("data", (d) => { if (String(d).indexOf("TATAO") === 0) fin({ ok: true, ms: Date.now() - t0, method: "tatao" }); });
    s.on("error", () => fin(null));
  }).then((r) => r || pingIp(ip));
}

// ---------- Rede LAN do Tátão: placa de rede virtual (Wintun) + túnel P2P pela conexão da sala ----------
// O Windows manda os pacotes do jogo pra placa "TataoLAN"; o Tátão leva cada pacote direto pro PC do amigo
// pelo canal WebRTC criptografado e escreve na placa dele. Igual ao Radmin, mas sem servidor no meio.
const { Worker } = require("worker_threads");
const LAN_NAME = "TataoLAN";
const LAN_GUID = { Data1: 0x7a7a0001, Data2: 0x7a7a, Data3: 0x4c41, Data4: [0x4e, 0x54, 0x41, 0x54, 0x41, 0x4f, 0x30, 0x31] }; // fixo: o Windows reconhece sempre a mesma rede
let lan = { running: false };
let lanApi = null;
function lanMockPath() { return !app.isPackaged && process.env.TATAO_LAN_MOCK ? process.env.TATAO_LAN_MOCK : null; } // só em teste de desenvolvimento
function isAdmin() {
  if (process.platform !== "win32") return true;
  try { require("child_process").execSync("net session", { stdio: "ignore", windowsHide: true }); return true; } catch (_) { return false; }
}
function runCmd(cmd, args) {
  return new Promise((res) => {
    let out = "", p;
    try { p = spawn(cmd, args, { windowsHide: true }); } catch (e) { res({ code: -1, out: String(e) }); return; }
    if (p.stdout) p.stdout.on("data", (d) => out += d);
    if (p.stderr) p.stderr.on("data", (d) => out += d);
    p.on("error", (e) => res({ code: -1, out: String(e) }));
    p.on("close", (c) => res({ code: c, out }));
  });
}
function hasIp(ip) { const ifs = os.networkInterfaces(); for (const k in ifs) for (const a of ifs[k]) if (a.address === ip) return true; return false; }
async function configureLanIp(ip, mask) {
  // a placa recém-criada pode levar um instante pra aceitar configuração
  for (let i = 0; i < 8 && !hasIp(ip); i++) {
    await runCmd("netsh", ["interface", "ipv4", "set", "address", "name=" + LAN_NAME, "source=static", "address=" + ip, "mask=" + mask]);
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!hasIp(ip)) return false;
  // métrica baixa: a busca de partidas em LAN (broadcast) sai por esta placa
  await runCmd("netsh", ["interface", "ipv4", "set", "interface", "interface=" + LAN_NAME, "metric=5"]);
  await runCmd("netsh", ["interface", "ipv4", "set", "subinterface", LAN_NAME, "mtu=1380", "store=active"]);
  // rede "Privada": o firewall do Windows deixa os jogos receberem conexões dos amigos
  setTimeout(() => { runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-NetConnectionProfile -InterfaceAlias " + LAN_NAME + " -NetworkCategory Private"]); }, 6000);
  return true;
}
function loadLanApi(dll) {
  if (lanApi) return lanApi;
  const koffi = require("koffi");
  const L = koffi.load(dll);
  koffi.struct("TATAO_GUID", { Data1: "uint32_t", Data2: "uint16_t", Data3: "uint16_t", Data4: koffi.array("uint8_t", 8) });
  lanApi = {
    koffi,
    open: L.func("void *WintunOpenAdapter(const char16_t *Name)"),
    create: L.func("void *WintunCreateAdapter(const char16_t *Name, const char16_t *TunnelType, const TATAO_GUID *RequestedGUID)"),
    close: L.func("void WintunCloseAdapter(void *Adapter)"),
    start: L.func("void *WintunStartSession(void *Adapter, uint32_t Capacity)"),
    end: L.func("void WintunEndSession(void *Session)"),
    event: L.func("void *WintunGetReadWaitEvent(void *Session)"),
    alloc: L.func("uint8_t *WintunAllocateSendPacket(void *Session, uint32_t PacketSize)"),
    sendp: L.func("void WintunSendPacket(void *Session, const uint8_t *Packet)")
  };
  return lanApi;
}
async function lanStart(opts) {
  opts = opts || {};
  const ip = String(opts.ip || ""), mask = String(opts.mask || "255.255.0.0");
  if (!/^10\.77\.\d{1,3}\.\d{1,3}$/.test(ip)) return { ok: false, error: "IP da rede inválido." };
  if (lan.running) { if (lan.ip === ip) return { ok: true, ip }; await lanStop(); }
  const mock = lanMockPath();
  if (process.platform !== "win32" && !mock) return { ok: false, error: "A rede LAN do Tátão funciona no Windows." };
  if (!mock && !isAdmin()) return { ok: false, needAdmin: true };
  const dll = mock || path.join(process.resourcesPath, "wintun.dll");
  if (!fs.existsSync(dll)) return { ok: false, error: "O componente da placa de rede (wintun.dll) não veio junto com o app. Baixe o Tátão de novo pelo GitHub." };
  let A;
  try { A = loadLanApi(dll); } catch (e) { return { ok: false, error: "Não consegui carregar o componente de rede: " + ((e && e.message) || e) }; }
  let adapter = A.open(LAN_NAME);
  if (!adapter) adapter = A.create(LAN_NAME, "Tatao", LAN_GUID);
  if (!adapter) return { ok: false, error: "O Windows não deixou criar a placa de rede virtual." };
  const session = A.start(adapter, 0x400000); // 4 MB de fila
  if (!session) { try { A.close(adapter); } catch (_) {} return { ok: false, error: "Não consegui ligar a placa de rede virtual." }; }
  const ev = A.event(session);
  if (!mock) {
    const ok = await configureLanIp(ip, mask);
    if (!ok) { try { A.end(session); A.close(adapter); } catch (_) {} return { ok: false, error: "A placa foi criada, mas o Windows não aceitou o IP " + ip + "." }; }
  }
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const wpath = path.join(__dirname, "lan-worker.js").replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
  let worker;
  try { worker = new Worker(wpath, { workerData: { dll, session: A.koffi.address(session), event: A.koffi.address(ev), stop } }); }
  catch (e) { try { A.end(session); A.close(adapter); } catch (_) {} return { ok: false, error: "Falha ao iniciar a leitura da rede: " + ((e && e.message) || e) }; }
  const me = { running: true, ip, adapter, session, worker, stop, rx: 0, tx: 0 };
  worker.on("message", (u8) => { me.rx++; send("lan:in", Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)); });
  worker.on("error", (e) => { if (lan === me) send("lan:status", { state: "error", error: String((e && e.message) || e) }); });
  lan = me;
  return { ok: true, ip };
}
function lanWrite(buf) {
  if (!lan.running || !buf) return;
  const n = buf.length >>> 0;
  if (n < 20 || n > 65535) return;
  const p = lanApi.alloc(lan.session, n);
  if (!p) return; // fila cheia: descarta, como uma rede faria
  lanApi.koffi.encode(p, "uint8_t", buf, n); // copia pro buffer do Wintun (o Electron não permite apontar direto)
  lanApi.sendp(lan.session, p);
  lan.tx++;
}
async function lanStop() {
  if (!lan.running) return { ok: true };
  const cur = lan; lan = { running: false };
  Atomics.store(cur.stop, 0, 1);
  await new Promise((r) => { const t = setTimeout(r, 1500); cur.worker.once("exit", () => { clearTimeout(t); r(); }); });
  try { await cur.worker.terminate(); } catch (_) {}
  try { lanApi.end(cur.session); } catch (_) {}
  try { lanApi.close(cur.adapter); } catch (_) {}
  return { ok: true };
}
// reabre o Tátão como administrador (o Windows pergunta) e volta pra mesma sala com a rede ligada
function relaunchElevated(resume) {
  if (process.platform !== "win32") return { ok: false };
  const exe = app.getPath("exe").replace(/'/g, "''");
  const arg = "--tatao-resume=" + Buffer.from(JSON.stringify(resume || {})).toString("base64");
  const ps = "try { Start-Process -FilePath '" + exe + "' -ArgumentList '" + arg + "' -Verb RunAs -ErrorAction Stop } catch { Start-Process -FilePath '" + exe + "' }";
  lanStop().finally(() => {
    try { app.releaseSingleInstanceLock(); } catch (_) {}
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(() => app.quit(), 300);
  });
  return { ok: true };
}
function resumeArg() {
  const pre = "--tatao-resume=";
  const a = process.argv.find((x) => String(x).startsWith(pre));
  if (!a) return null;
  try { return JSON.parse(Buffer.from(a.slice(pre.length), "base64").toString("utf8")); } catch (_) { return null; }
}

// ---------- áudio do PC: Spotify (ou qualquer app) pra sala, sem pegar as vozes do Tátão ----------
// Um programinha (tatao-audio.exe) usa a captura por processo do Windows e entrega o som cru;
// o Tátão repassa pra janela, que transforma numa trilha de áudio e manda pros amigos.
const pcCaps = new Map();
let pcSeq = 0;
function pcHelperPath() {
  if (!app.isPackaged && process.env.TATAO_AUDIO_MOCK) return process.env.TATAO_AUDIO_MOCK; // só em teste de desenvolvimento
  return path.join(process.resourcesPath, "tatao-audio.exe");
}
function pcSpawn(args) {
  const exe = pcHelperPath();
  if (/\.(js|cjs)$/i.test(exe)) return spawn(process.execPath, [exe, ...args], { windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }) });
  return spawn(exe, args, { windowsHide: true });
}
function pcAvailable() {
  const exe = pcHelperPath();
  return (process.platform === "win32" || !!process.env.TATAO_AUDIO_MOCK) && fs.existsSync(exe);
}
function pcList() {
  return new Promise((resolve) => {
    if (!pcAvailable()) { resolve({ ok: false, error: "unavailable" }); return; }
    let out = "", err = "", p;
    try { p = pcSpawn(["list", String(process.pid)]); } catch (e) { resolve({ ok: false, error: String(e) }); return; }
    const t = setTimeout(() => { try { p.kill(); } catch (_) {} }, 6000);
    p.stdout.on("data", (d) => out += d);
    p.stderr.on("data", (d) => err += d);
    p.on("error", (e) => { clearTimeout(t); resolve({ ok: false, error: String(e) }); });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) { resolve({ ok: false, error: (err.trim() || ("código " + code)) }); return; }
      const apps = out.split(/\r?\n/).map((l) => l.split("\t")).filter((c) => c.length >= 3 && +c[0] > 0)
        .map((c) => ({ pid: +c[0], active: c[1] === "1", exe: c.slice(2).join("\t") }));
      resolve({ ok: true, apps });
    });
  });
}
function pcStart(o) {
  o = o || {};
  return new Promise((resolve) => {
    if (!pcAvailable()) { resolve({ ok: false, error: "unavailable" }); return; }
    const mode = o.mode === "include" ? "include" : "exclude";
    const target = mode === "include" ? (parseInt(o.pid, 10) || 0) : process.pid; // "exclude" = tudo menos o próprio Tátão
    if (!target) { resolve({ ok: false, error: "App inválido." }); return; }
    const id = ++pcSeq;
    let p;
    try { p = pcSpawn(["capture", mode, String(target), String(process.pid)]); } catch (e) { resolve({ ok: false, error: String(e) }); return; }
    const c = { id, p, ready: false, rest: null, block: 4, settled: false };
    pcCaps.set(id, c);
    const finish = (r) => { if (!c.settled) { c.settled = true; clearTimeout(c.timer); resolve(r); } };
    c.timer = setTimeout(() => { finish({ ok: false, error: "O Windows não respondeu a tempo." }); pcStop(id); }, 9000);
    let errBuf = "";
    p.stderr.on("data", (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i).trim(); errBuf = errBuf.slice(i + 1);
        let m;
        if ((m = /^READY (\d+) (\d+)/.exec(line))) {
          c.ready = true; c.rate = +m[1]; c.ch = +m[2]; c.block = c.ch * 2;
          finish({ ok: true, id, rate: c.rate, ch: c.ch });
        } else if ((m = /^ERR (\S+) (.*)$/.exec(line))) {
          finish({ ok: false, error: m[2] + " (" + m[1] + ")", code: m[1] });
        }
      }
    });
    p.stdout.on("data", (d) => {
      if (!c.ready || !win || win.isDestroyed()) return;
      let b = c.rest ? Buffer.concat([c.rest, d]) : d; // não corta uma amostra no meio
      const n = b.length - (b.length % c.block);
      c.rest = n < b.length ? Buffer.from(b.subarray(n)) : null;
      if (n > 0) win.webContents.send("pcaudio:data", id, b.subarray(0, n));
    });
    p.on("error", (e) => { finish({ ok: false, error: String((e && e.message) || e) }); });
    p.on("close", (code) => {
      pcCaps.delete(id);
      finish({ ok: false, error: "O capturador fechou (código " + code + ")." });
      send("pcaudio:end", { id, code });
    });
  });
}
function pcStop(id) {
  const ids = id == null ? Array.from(pcCaps.keys()) : [id];
  for (const k of ids) { const c = pcCaps.get(k); if (c) { pcCaps.delete(k); try { c.p.kill(); } catch (_) {} } }
  return { ok: true };
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
let shareOpts = { type: "all", audio: true }; // definido pela tela antes de cada transmissão
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 820, minHeight: 560,
    backgroundColor: "#0b111d", autoHideMenuBar: true, title: "Tátão",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "sala-lan.html"));
  // links externos abrem no navegador, não numa janela do app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });

  // o player do YouTube recusa tocar (erro 153) quando o pedido não diz de onde veio; uma página local não manda isso
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube.com/*", "https://www.youtube-nocookie.com/*", "https://*.googlevideo.com/*", "https://*.ytimg.com/*"] },
    (d, cb) => {
      const hd = d.requestHeaders;
      if (!hd.Referer && !hd.referer) hd.Referer = "https://github.com/pauloestefani/T-t-o"; // identifica o app de verdade
      cb({ requestHeaders: hd });
    });
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(true));
  session.defaultSession.setPermissionCheckHandler(() => true); // nomes dos microfones/fones e troca de saída de áudio
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const types = shareOpts.type === "screen" ? ["screen"] : shareOpts.type === "window" ? ["window"] : ["screen", "window"];
    const give = (src) => {
      if (!src) { try { callback(); } catch (_) {} return; }
      const opts = { video: src };
      if (shareOpts.audio && process.platform === "win32") opts.audio = "loopback";
      try { callback(opts); } catch (_) { try { callback({ video: src }); } catch (__) {} }
    };
    desktopCapturer.getSources({ types, thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false })
      .then((sources) => {
        if (shareOpts.type === "screen" && sources.length === 1) { give(sources[0]); return; } // um monitor só: vai direto
        send("pick-source", sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
        ipcMain.once("source-picked", (_e, id) => { give(id ? (sources.find((s) => s.id === id) || sources[0]) : null); });
      }).catch(() => give(null));
  });

  win.webContents.once("did-finish-load", () => {
    setTimeout(checkUpdate, 4000);
    const r = resumeArg(); if (r) send("lan:resume", r);
  });
  // saiu da sala (a tela recarrega): desliga a placa de rede
  win.webContents.on("did-start-loading", () => { if (lan.running) lanStop(); pcStop(); });
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
ipcMain.handle("open:external", (_e, url) => { try { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); } catch (_) {} });
ipcMain.handle("lan:info", () => lanInfo());
ipcMain.handle("lan:listen", () => startProbe());
ipcMain.handle("lan:probe", (_e, ip) => lanProbe(ip));
ipcMain.handle("lan:start", (_e, o) => lanStart(o));
ipcMain.handle("lan:stop", () => lanStop());
ipcMain.handle("lan:elevate", (_e, r) => relaunchElevated(r));
ipcMain.on("lan:out", (_e, buf) => { try { lanWrite(buf); } catch (_) {} });
ipcMain.handle("pcaudio:available", () => pcAvailable());
ipcMain.handle("pcaudio:list", () => pcList());
ipcMain.handle("pcaudio:start", (_e, o) => pcStart(o));
ipcMain.handle("pcaudio:stop", (_e, id) => pcStop(id));
ipcMain.on("share:opts", (_e, o) => {
  o = o || {};
  shareOpts = { type: ["screen", "window", "all"].includes(o.type) ? o.type : "all", audio: o.audio !== false };
});
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
  app.on("before-quit", () => { stopPeerServer(); try { if (probeSrv) probeSrv.close(); } catch (_) {} lanStop(); pcStop(); });
}
