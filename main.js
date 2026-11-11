// Tátão — processo principal (Electron)
// Janela + captura de tela + memória de configs + servidor embutido + AUTO-UPDATE (GitHub Releases).
const { app, BrowserWindow, session, desktopCapturer, ipcMain, Menu, shell, screen, dialog } = require("electron");
const crypto = require("crypto");
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
let lan = { running: false }, lanSeq = 0;
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
  // o aviso de "Abrir para LAN" do Minecraft (224.0.2.60) sai por esta placa, e não pela rede normal
  await runCmd("netsh", ["interface", "ipv4", "add", "route", "prefix=" + MC_GROUP + "/32", "interface=" + LAN_NAME, "metric=1", "store=active"]);
  // rede "Privada": o firewall do Windows deixa os jogos receberem conexões dos amigos
  // (o Windows leva uns segundos pra "identificar" a rede nova; tenta até conseguir)
  (async () => {
    const ps = "$p=Get-NetConnectionProfile -InterfaceAlias " + LAN_NAME + " -ErrorAction SilentlyContinue; if($p){ if($p.NetworkCategory -ne 'Private'){ Set-NetConnectionProfile -InterfaceAlias " + LAN_NAME + " -NetworkCategory Private -ErrorAction SilentlyContinue }; (Get-NetConnectionProfile -InterfaceAlias " + LAN_NAME + ").NetworkCategory }";
    const g = lanSeq;
    for (let i = 0; i < 8 && g === lanSeq; i++) {
      await new Promise((r) => setTimeout(r, i ? 5000 : 3000));
      const r = await runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
      if (/Private/.test(r.out)) { send("lan:status", { state: "private" }); return; }
    }
    send("lan:status", { state: "notprivate" });
  })();
  return true;
}
// ---------- Minecraft: percebe quando um mundo é aberto pra LAN neste PC ----------
// O Minecraft (Java) avisa a cada 1,5 s em 224.0.2.60:4445: "[MOTD]nome[/MOTD][AD]porta[/AD]".
const MC_GROUP = "224.0.2.60", MC_PORT = 4445;
const mcMinePorts = new Map(); // portas de mundos abertos NESTE PC (só elas podem ser usadas pelo túnel)
const mcManualPorts = new Set(); // portas que a própria pessoa escolheu compartilhar na aba LAN
function localIps() { const out = new Set(["127.0.0.1"]); const ifs = os.networkInterfaces(); for (const k in ifs) for (const a of ifs[k]) if (a.family === "IPv4" || a.family === 4) out.add(a.address); return out; }
// Acha mundos abertos olhando quem está escutando no PC (o Java do Minecraft) e confirmando com o
// "ping de status" do próprio Minecraft. Não depende do aviso de rede do jogo (que o firewall ou outra VPN podem desviar).
const MC_PROCS = (!app.isPackaged && process.env.TATAO_MC_PROCS) ? new RegExp("^(" + process.env.TATAO_MC_PROCS + "|javaw?)(\\.exe)?$", "i") : /^javaw?(\.exe)?$/i;
const mcNotMc = new Map(); // porta -> quando foi vista e não era Minecraft (não pergunta de novo por 1 min)
let mcScanTimer = null, mcScanning = false;
function varInt(n) { const out = []; n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); }
function readVarInt(b, o) { let v = 0, s = 0, i = o; while (i < b.length) { const x = b[i++]; v |= (x & 0x7f) << s; if (!(x & 0x80)) return [v >>> 0, i]; s += 7; if (s > 28) return null; } return undefined; }
function mcText(d) { if (d == null) return ""; if (typeof d === "string") return d; if (Array.isArray(d)) return d.map(mcText).join(""); return (d.text || "") + (Array.isArray(d.extra) ? d.extra.map(mcText).join("") : ""); }
function mcStatus(port) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port }); let buf = Buffer.alloc(0), done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} res(v); };
    s.setTimeout(2500, () => fin(null)); s.on("error", () => fin(null)); s.on("close", () => fin(null));
    s.on("connect", () => {
      const host = Buffer.from("127.0.0.1"), pb = Buffer.alloc(2); pb.writeUInt16BE(port);
      const body = Buffer.concat([varInt(0), varInt(0xffffffff), varInt(host.length), host, pb, varInt(1)]);
      s.write(Buffer.concat([varInt(body.length), body, varInt(1), varInt(0)]));
    });
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]); if (buf.length > 262144) return fin(null);
      const L = readVarInt(buf, 0); if (L === undefined) return; if (!L) return fin(null);
      if (buf.length < L[1] + L[0]) return;
      const id = readVarInt(buf, L[1]); if (!id || id[0] !== 0) return fin(null);
      const sl = readVarInt(buf, id[1]); if (!sl) return fin(null);
      try { const j = JSON.parse(buf.slice(sl[1], sl[1] + sl[0]).toString("utf8")); fin({ motd: mcText(j.description).replace(/§./g, "").trim().slice(0, 60), version: j.version && j.version.name }); } catch (_) { fin(null); }
    });
  });
}
async function javaListenPorts() {
  const ports = new Set();
  if (process.platform === "win32") {
    const t = await runCmd("tasklist", ["/FO", "CSV", "/NH"]), pids = new Set();
    for (const line of t.out.split(/\r?\n/)) { const m = /^"([^"]+)","(\d+)"/.exec(line); if (m && MC_PROCS.test(m[1])) pids.add(m[2]); }
    if (!pids.size) return [];
    const n = await runCmd("netstat", ["-ano"]);
    // "TCP  0.0.0.0:1111  0.0.0.0:0  LISTENING  1234" (o nome do estado muda com o idioma; o endereço remoto zerado não)
    for (const line of n.out.split(/\r?\n/)) { const m = /^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$/i.exec(line); if (m && pids.has(m[3])) ports.add(+m[2]); }
  } else if (process.platform === "linux") {
    // (Linux, só pra desenvolver/testar) portas em escuta pelo /proc
    const inodes = new Map();
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let txt = ""; try { txt = fs.readFileSync(f, "utf8"); } catch (_) { continue; }
      for (const line of txt.split("\n").slice(1)) { const c = line.trim().split(/\s+/); if (c[3] === "0A") inodes.set(c[9], parseInt(c[1].split(":")[1], 16)); }
    }
    for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      let comm = ""; try { comm = fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim(); } catch (_) { continue; }
      if (!MC_PROCS.test(comm)) continue;
      let fds = []; try { fds = fs.readdirSync("/proc/" + pid + "/fd"); } catch (_) { continue; }
      for (const fd of fds) { let l = ""; try { l = fs.readlinkSync("/proc/" + pid + "/fd/" + fd); } catch (_) { continue; } const m = /^socket:\[(\d+)\]$/.exec(l); if (m && inodes.has(m[1])) ports.add(inodes.get(m[1])); }
    }
  }
  for (const p of tunLocalPorts) ports.delete(p); // as portas do próprio túnel não são mundos
  return [...ports];
}
async function mcScan() {
  if (mcScanning) return; mcScanning = true;
  try {
    const now = Date.now();
    for (const port of await javaListenPorts()) {
      if (now - (mcNotMc.get(port) || 0) < 60000) continue;
      const st = await mcStatus(port);
      if (!st) { mcNotMc.set(port, now); continue; }
      mcMinePorts.set(port, Date.now());
      send("lan:mcworld", { port, motd: st.motd || "Mundo do Minecraft", mine: true, version: st.version || "" });
    }
  } catch (_) {} finally { mcScanning = false; }
}
function mcListenStart() { if (mcScanTimer) return; mcScan(); mcScanTimer = setInterval(mcScan, 5000); }
function mcRefresh() {}
function mcListenStop() { if (mcScanTimer) { clearInterval(mcScanTimer); mcScanTimer = null; } mcNotMc.clear(); }
// No PC do amigo: avisa o Minecraft dele (como o "Abrir para LAN" faz) que tem um mundo em 127.0.0.1:porta do túnel,
// pra ele aparecer sozinho na aba Multijogador.
let mcAnnSock = null, mcAnnTimer = null;
function mcAnnounceTick() {
  const list = [...tunServers.values()].filter((t) => t.label);
  if (!list.length) { if (mcAnnTimer) { clearInterval(mcAnnTimer); mcAnnTimer = null; } if (mcAnnSock) { try { mcAnnSock.close(); } catch (_) {} mcAnnSock = null; } return; }
  if (!mcAnnSock) { mcAnnSock = require("dgram").createSocket("udp4"); mcAnnSock.on("error", () => {}); mcAnnSock.bind(0, "127.0.0.1"); }
  for (const t of list) { try { mcAnnSock.send(Buffer.from("[MOTD]" + t.label + "[/MOTD][AD]" + t.port + "[/AD]"), MC_PORT, "127.0.0.1"); } catch (_) {} }
}
let mcWatchRoom = false;
ipcMain.on("mc:watch", (_e, on) => {
  if (!app.isPackaged && process.env.TATAO_NO_MC) return; // só em teste: dois apps no mesmo PC
  mcWatchRoom = !!on; if (mcWatchRoom || lan.running) mcListenStart(); else mcListenStop();
});

// ---------- Túnel do Tátão: o Minecraft do amigo entra por localhost e a conversa passa pela conexão da sala ----------
// (sem firewall, sem rede LAN e sem VPN no meio). Quem abriu o mundo só aceita ligar pra portas de mundos abertos neste PC.
const tunSocks = new Map(), tunServers = new Map(), tunLocalPorts = new Set();
let tunSeq = 0;
function tunAttach(id, sock) {
  tunSocks.set(id, sock); sock.setNoDelay(true); sock.pause();
  sock.on("data", (d) => send("tun:data", id, d));
  sock.on("close", () => { if (tunSocks.get(id) === sock) { tunSocks.delete(id); send("tun:close", id); } });
  sock.on("error", () => {});
}
ipcMain.handle("tun:listen", (_e, key, want, label) => {
  key = String(key || "").slice(0, 100); want = Math.floor(+want) || 0;
  label = String(label || "").replace(/[\[\]\x00-\x1f]/g, "").slice(0, 80);
  const cur = tunServers.get(key); if (cur) { if (label) cur.label = label; return { ok: true, port: cur.port }; }
  return new Promise((res) => {
    const srv = net.createServer((sock) => { const id = ++tunSeq; tunAttach(id, sock); send("tun:incoming", key, id); });
    const go = (p) => {
      srv.once("error", (e) => { if (p) go(0); else res({ ok: false, error: String((e && e.message) || e) }); });
      srv.listen(p, "127.0.0.1", () => {
        const port = srv.address().port; tunServers.set(key, { srv, port, label }); tunLocalPorts.add(port); res({ ok: true, port });
        if (label && !mcAnnTimer) { mcAnnTimer = setInterval(mcAnnounceTick, 1500); mcAnnounceTick(); }
      });
    };
    go(want > 1024 && want < 65536 ? want : 0);
  });
});
ipcMain.handle("tun:unlisten", (_e, key) => { const t = tunServers.get(String(key)); if (t) { tunServers.delete(String(key)); tunLocalPorts.delete(t.port); try { t.srv.close(); } catch (_) {} } return true; });
ipcMain.on("mc:share", (_e, port, on) => { port = Math.floor(+port); if (!(port > 0 && port < 65536)) return; if (on) mcManualPorts.add(port); else mcManualPorts.delete(port); });
ipcMain.handle("tun:connect", (_e, port) => {
  port = Math.floor(+port);
  const seen = mcMinePorts.get(port);
  if (!mcManualPorts.has(port) && (!seen || Date.now() - seen > 60000)) return { ok: false, error: "esse jogo não está aberto neste PC" };
  return new Promise((res) => {
    const sock = net.connect({ host: "127.0.0.1", port }), id = ++tunSeq;
    sock.once("connect", () => { sock.removeAllListeners("error"); tunAttach(id, sock); res({ ok: true, id }); });
    sock.once("error", (e) => res({ ok: false, error: String((e && e.message) || e) }));
  });
});
ipcMain.on("tun:write", (_e, id, buf) => { const s = tunSocks.get(id); if (s && buf) { try { s.write(buf.buffer ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : Buffer.from(buf)); } catch (_) {} } });
ipcMain.on("tun:pause", (_e, id, on) => { const s = tunSocks.get(id); if (s) { if (on) s.pause(); else s.resume(); } });
ipcMain.on("tun:end", (_e, id) => { const s = tunSocks.get(id); if (s) { tunSocks.delete(id); try { s.destroy(); } catch (_) {} } });
function tunCloseAll() { mcManualPorts.clear(); setTimeout(mcAnnounceTick, 0); for (const s of tunSocks.values()) { try { s.destroy(); } catch (_) {} } tunSocks.clear(); for (const t of tunServers.values()) { try { t.srv.close(); } catch (_) {} } tunServers.clear(); tunLocalPorts.clear(); }
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
  mcListenStart(); mcRefresh();
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
  const cur = lan; lan = { running: false }; lanSeq++;
  if (!mcWatchRoom) mcListenStop();
  if (process.platform === "win32" && !lanMockPath()) runCmd("netsh", ["interface", "ipv4", "delete", "route", "prefix=" + MC_GROUP + "/32", "interface=" + LAN_NAME, "store=active"]);
  Atomics.store(cur.stop, 0, 1);
  await new Promise((r) => { const t = setTimeout(r, 1500); cur.worker.once("exit", () => { clearTimeout(t); r(); }); });
  try { await cur.worker.terminate(); } catch (_) {}
  try { lanApi.end(cur.session); } catch (_) {}
  try { lanApi.close(cur.adapter); } catch (_) {}
  return { ok: true };
}
// reabre o Tátão como administrador (o Windows pergunta) e volta pra mesma sala com a rede ligada
// Pede ao Windows pra abrir o Tátão como administrador. Usa a própria janela como dona do aviso,
// assim ele aparece na frente (pelo PowerShell escondido, o aviso podia ficar só piscando na barra de tarefas).
let _shellExec = null;
function shellRunAs(exe, params, owner) {
  if (!_shellExec) {
    const koffi = require("koffi");
    _shellExec = koffi.load("shell32.dll").func("intptr_t __stdcall ShellExecuteW(intptr_t hwnd, const char16_t *op, const char16_t *file, const char16_t *params, const char16_t *dir, int show)");
  }
  let hwnd = 0;
  try { if (owner && !owner.isDestroyed()) { const b = owner.getNativeWindowHandle(); hwnd = b.length >= 8 ? b.readBigInt64LE(0) : b.readInt32LE(0); } } catch (_) {}
  const r = _shellExec(hwnd, "runas", exe, params || "", path.dirname(exe), 1); // bloqueia até a pessoa responder
  return Number(r) > 32;
}
function elevateNow(resume, owner) {
  if (process.platform !== "win32") return Promise.resolve({ ok: false });
  const exe = app.getPath("exe");
  const params = resume ? "--tatao-resume=" + Buffer.from(JSON.stringify(resume)).toString("base64") : "";
  return lanStop().catch(() => {}).then(() => {
    let ok = false;
    try { app.releaseSingleInstanceLock(); } catch (_) {}
    try { ok = shellRunAs(exe, params, owner || win || splash); }
    catch (e) { relaunchElevated(resume); return { ok: true, via: "powershell" }; } // sem a biblioteca: jeito antigo
    if (ok) { setTimeout(() => app.quit(), 200); return { ok: true }; }
    try { app.requestSingleInstanceLock(); } catch (_) {}
    return { ok: false, cancelled: true }; // a pessoa disse "Não": continua aberto normal
  });
}
// A mesma marca da opção "Executar este programa como administrador" das propriedades do .exe (só deste usuário).
const COMPAT_KEY = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers";
function readCompatFlags(exe) {
  try {
    const out = require("child_process").execFileSync("reg.exe", ["query", COMPAT_KEY, "/v", exe], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = out.split(/\r?\n/).find((l) => /\sREG_SZ\s/.test(l));
    return line ? line.split(/\sREG_SZ\s+/)[1].trim() : "";
  } catch (_) { return ""; }
}
function setRunAsAdminFlag(on) {
  if (process.platform !== "win32" || !app.isPackaged) return false;
  const exe = app.getPath("exe"), cur = readCompatFlags(exe);
  const toks = cur.replace(/^~\s*/, "").split(/\s+/).filter((t) => t && t.toUpperCase() !== "RUNASADMIN");
  if (on) toks.unshift("RUNASADMIN");
  const want = toks.length ? "~ " + toks.join(" ") : "";
  if (want === cur) return true;
  try {
    const cp = require("child_process");
    if (want) cp.execFileSync("reg.exe", ["add", COMPAT_KEY, "/v", exe, "/t", "REG_SZ", "/d", want, "/f"], { windowsHide: true, stdio: "ignore" });
    else cp.execFileSync("reg.exe", ["delete", COMPAT_KEY, "/v", exe, "/f"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch (_) { return false; }
}
function relaunchElevated(resume) {
  if (process.platform !== "win32") return { ok: false };
  const exe = app.getPath("exe").replace(/'/g, "''");
  const arg = resume ? "--tatao-resume=" + Buffer.from(JSON.stringify(resume)).toString("base64") : "";
  // se a pessoa disser "Não" no Windows, abre normal (e não pede de novo, mesmo com "sempre como administrador")
  const ps = "try { Start-Process -FilePath '" + exe + "'" + (arg ? " -ArgumentList '" + arg + "'" : "") + " -Verb RunAs -ErrorAction Stop } catch { Start-Process -FilePath '" + exe + "' -ArgumentList '--tatao-noelevate' }";
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

// ---------- música: links do Deezer viram lista de faixas; cada faixa é achada no YouTube ----------
// O Deezer tem API pública (sem chave). A busca no YouTube usa a API oficial e precisa de uma chave grátis.
const elNet = require("electron").net;
function appKeys() { try { return JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "keys.json"), "utf8")) || {}; } catch (_) { return {}; } }
function userYtKey() { return String(readCfg().ytKey || "").trim(); }
function ytKey() { return userYtKey() || String(appKeys().ytKey || "").trim(); }
async function getJson(url, opts) {
  const r = await elNet.fetch(url, Object.assign({ headers: { "User-Agent": "Tatao/" + app.getVersion() } }, opts || {}));
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, url: r.url, text };
}
const DZ_RE = /deezer\.com\\?\/(?:[a-z]{2}(?:-[a-z]{2})?\\?\/)?(track|playlist|album)\\?\/(\d+)/i;
async function deezerResolve(raw) {
  const u = String(raw || "").trim();
  let m = DZ_RE.exec(u);
  if (!m) { // link curto (link.deezer.com/s/…): segue o redirecionamento
    try {
      const r = await elNet.fetch(u, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
      m = DZ_RE.exec(r.url || "") || DZ_RE.exec(await r.text());
    } catch (_) {}
  }
  if (!m) return { ok: false, error: "Não reconheci esse link do Deezer." };
  const kind = m[1].toLowerCase(), id = m[2];
  const map = (t) => ({ title: String(t.title || ""), artist: String((t.artist && t.artist.name) || ""), dur: +t.duration || 0 });
  if (kind === "track") {
    const r = await getJson("https://api.deezer.com/track/" + id);
    if (!r.json || r.json.error || !r.json.title) return { ok: false, error: "O Deezer não achou essa música." };
    return { ok: true, kind, title: r.json.title, items: [map(r.json)] };
  }
  const head = await getJson("https://api.deezer.com/" + kind + "/" + id);
  if (!head.json || head.json.error) return { ok: false, error: kind === "album" ? "O Deezer não achou esse álbum." : "O Deezer não achou essa playlist (ela é pública?)." };
  const items = [];
  let next = "https://api.deezer.com/" + kind + "/" + id + "/tracks?limit=100&index=0";
  while (next && items.length < 300) {
    const r = await getJson(next);
    if (!r.json || !Array.isArray(r.json.data)) break;
    r.json.data.forEach((t) => { if (t && t.title) items.push(map(t)); });
    next = r.json.next && /^https:\/\/api\.deezer\.com\//.test(r.json.next) ? r.json.next : null;
  }
  if (!items.length) return { ok: false, error: "Essa lista do Deezer está vazia." };
  return { ok: true, kind, title: String(head.json.title || ""), items: items.slice(0, 300) };
}
// cache das buscas (cada busca gasta cota da chave): arquivo separado das configurações
const YT_CACHE = path.join(app.getPath("userData"), "yt-cache.json");
let ytCache = null;
function ytCacheGet(k) { if (!ytCache) { try { ytCache = JSON.parse(fs.readFileSync(YT_CACHE, "utf8")) || {}; } catch (_) { ytCache = {}; } } return ytCache[k]; }
function ytCachePut(k, v) {
  ytCacheGet(k); delete ytCache[k]; ytCache[k] = v;
  const ks = Object.keys(ytCache); if (ks.length > 1500) ks.slice(0, ks.length - 1500).forEach((x) => delete ytCache[x]);
  try { fs.writeFileSync(YT_CACHE, JSON.stringify(ytCache)); } catch (_) {}
}
function normTxt(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function unEnt(s) { return String(s || "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }
function isoDur(s) { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || ""); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; }
function ytErrCode(r) {
  const e = r.json && r.json.error, reason = (e && e.errors && e.errors[0] && e.errors[0].reason) || "";
  if (/quota|rateLimit/i.test(reason)) return "quota";
  if (/keyInvalid|keyExpired/i.test(reason) || r.status === 400) return "badkey";
  if (/accessNotConfigured|forbidden|ipRefererBlocked/i.test(reason) || r.status === 403) return "forbidden";
  return "http" + r.status;
}
// versões que quase nunca são o que a pessoa quer (a não ser que o nome original tenha)
const YT_BAD = ["live", "ao vivo", "en vivo", "cover", "karaoke", "sped up", "slowed", "8d", "nightcore", "instrumental", "acustico", "acoustic", "reaction", "react", "tutorial", "remix", "mashup", "1 hour", "10 hours", "loop"];
async function ytSearch(o) {
  o = o || {};
  const q = String(o.q || "").slice(0, 200).trim(), title = String(o.title || ""), artist = String(o.artist || ""), dur = +o.dur || 0;
  if (!q) return { ok: false, error: "notfound" };
  const key = ytKey(); if (!key) return { ok: false, error: "nokey" };
  const ck = normTxt(q) + "|" + Math.round(dur / 5);
  const hit = ytCacheGet(ck); if (hit && hit.id) return Object.assign({ ok: true, cached: true }, hit);
  const sr = await getJson("https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&q=" + encodeURIComponent(q) + "&key=" + encodeURIComponent(key));
  if (sr.status !== 200) return { ok: false, error: ytErrCode(sr) };
  const items = ((sr.json && sr.json.items) || []).filter((i) => i.id && /^[A-Za-z0-9_-]{11}$/.test(i.id.videoId || ""));
  if (!items.length) return { ok: false, error: "notfound" };
  const durs = {};
  try {
    const vr = await getJson("https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=" + items.map((i) => i.id.videoId).join(",") + "&key=" + encodeURIComponent(key));
    ((vr.json && vr.json.items) || []).forEach((v) => { durs[v.id] = isoDur(v.contentDetails && v.contentDetails.duration); });
  } catch (_) {}
  const nt = normTxt(title), na = normTxt(artist);
  let best = null;
  items.forEach((it, i) => {
    const sn = it.snippet || {}, vt = normTxt(unEnt(sn.title)), ch = normTxt(unEnt(sn.channelTitle));
    let s = 3 - i * 0.4;
    if (/ topic$/.test(ch)) s += 3;                       // áudio oficial gerado pelo YouTube
    if (/vevo/.test(ch)) s += 2;
    if (na && ch && (ch.indexOf(na) >= 0 || na.indexOf(ch) >= 0)) s += 2;
    if (nt && vt.indexOf(nt) >= 0) s += 2;
    if (/\b(official|oficial)\b/.test(vt)) s += 1;
    YT_BAD.forEach((w) => { const re = new RegExp("\\b" + w + "\\b"); if (re.test(vt) && !re.test(nt)) s -= 4; });
    const d = durs[it.id.videoId];
    if (dur && d) { const df = Math.abs(d - dur); s += df <= 5 ? 3 : df <= 15 ? 1.5 : df > 60 ? -3 : 0; }
    if (!best || s > best.s) best = { s, id: it.id.videoId, title: unEnt(sn.title), channel: unEnt(sn.channelTitle) };
  });
  const res = { id: best.id, title: best.title, channel: best.channel };
  ytCachePut(ck, res);
  return Object.assign({ ok: true }, res);
}
async function ytTestKey(k) {
  const key = String(k || "").trim() || ytKey(); if (!key) return { ok: false, error: "nokey" };
  try {
    const r = await getJson("https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=" + encodeURIComponent(key)); // gasta 1 de cota
    return r.status === 200 ? { ok: true } : { ok: false, error: ytErrCode(r) };
  } catch (e) { return { ok: false, error: "net" }; }
}

// ---------- arquivos: pasta escolhida pela pessoa, gravação por pedaços e compartilhamento ----------
const xfers = new Map();
let xferSeq = 0;
const FILES_CFG = path.join(app.getPath("userData"), "arquivos.json");
function filesCfg() { try { return JSON.parse(fs.readFileSync(FILES_CFG, "utf8")) || {}; } catch (_) { return {}; } }
function defaultRecvDir() { return path.join(app.getPath("downloads"), "Tátão"); }
function recvDir() {
  const want = String(filesCfg().dir || "");
  if (want) { try { fs.mkdirSync(want, { recursive: true }); if (fs.statSync(want).isDirectory()) return want; } catch (_) {} }
  const d = defaultRecvDir(); fs.mkdirSync(d, { recursive: true }); return d;
}
function setRecvDir(d) { const c = filesCfg(); if (d) c.dir = String(d); else delete c.dir; try { fs.writeFileSync(FILES_CFG, JSON.stringify(c, null, 2)); } catch (_) {} }
function dirInfo() { let d; try { d = recvDir(); } catch (_) { d = defaultRecvDir(); } return { dir: d, isDefault: path.resolve(d) === path.resolve(defaultRecvDir()) }; }
function safeFileName(n) {
  n = String(n || "arquivo").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 180) || "arquivo";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = "_" + n;
  return n;
}
function freePath(dir, name) {
  const taken = (p) => fs.existsSync(p) || fs.existsSync(p + ".part");
  let p = path.join(dir, name); if (!taken(p)) return p;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) { p = path.join(dir, base + " (" + i + ")" + ext); if (!taken(p)) return p; }
  return path.join(dir, Date.now() + "-" + name);
}
const normP = (p) => { const r = path.resolve(String(p)); return process.platform === "win32" ? r.toLowerCase() : r; };
const knownFiles = new Set(); // arquivos que o Tátão gravou ou está compartilhando (podem ficar fora da pasta atual)
function insideRecvDir(p) { try { const rel = path.relative(recvDir(), path.resolve(String(p))); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); } catch (_) { return false; } }
function allowedPath(p) { return !!p && (knownFiles.has(normP(p)) || insideRecvDir(p)); }
const RISKY_EXT = /\.(exe|msi|msix|appx|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|reg|jar|cpl|msc|dll|sys|inf|scf|url|iso|img|vhd|vhdx)$/i;
// o que dá pra mandar pros outros: só arquivos que a pessoa escolheu (pelo próprio Windows) ou que o Tátão baixou
const shares = new Map();
let shareSeq = 0;
function addShare(p, st) {
  for (const [sid, s] of shares) if (s.path === p && s.size === st.size && s.mtimeMs === st.mtimeMs) return sid;
  const sid = "s" + (++shareSeq); shares.set(sid, { path: p, size: st.size, mtimeMs: st.mtimeMs, fh: null, opening: null, last: 0 }); return sid;
}
async function shareRead(sid, pos, len) {
  const s = shares.get(String(sid)); if (!s) throw new Error("indisponivel");
  pos = Math.floor(+pos); len = Math.floor(+len);
  if (!(pos >= 0) || !(len >= 0) || len > (64 << 20) || pos + len > s.size) throw new Error("fora do arquivo");
  if (!s.fh) {
    if (!s.opening) s.opening = (async () => {
      const st = await fs.promises.stat(s.path);
      if (st.size !== s.size || Math.abs(st.mtimeMs - s.mtimeMs) > 2) throw new Error("mudou");
      return fs.promises.open(s.path, "r");
    })();
    try { s.fh = await s.opening; } finally { s.opening = null; }
  }
  s.last = Date.now();
  const buf = Buffer.allocUnsafe(len); let off = 0;
  while (off < len) { const r = await s.fh.read(buf, off, len - off, pos + off); if (!r.bytesRead) throw new Error("arquivo menor"); off += r.bytesRead; }
  return buf;
}
setInterval(() => { const now = Date.now(); for (const s of shares.values()) if (s.fh && now - s.last > 30000) { const fh = s.fh; s.fh = null; fh.close().catch(() => {}); } }, 15000).unref();
// biblioteca: arquivos que a pessoa topou compartilhar em cada servidor (voltam a ficar disponíveis quando ela entra)
const LIB_DIR = path.join(app.getPath("userData"), "biblioteca"), LIB_IDX = path.join(LIB_DIR, "index.json");
function libLoad() { try { const j = JSON.parse(fs.readFileSync(LIB_IDX, "utf8")); if (j && Array.isArray(j.entries)) return j; } catch (_) {} return { v: 1, entries: [] }; }
function libSave(j) { try { fs.mkdirSync(LIB_DIR, { recursive: true }); fs.writeFileSync(LIB_IDX + ".tmp", JSON.stringify(j)); fs.renameSync(LIB_IDX + ".tmp", LIB_IDX); } catch (_) {} }
const isHex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);
const validKey = (k) => typeof k === "string" && /^[a-z0-9-]{1,40}$/.test(k);
function libDropHashes(j, root) { if (!j.entries.some((e) => e.root === root)) { try { fs.rmSync(path.join(LIB_DIR, root + ".bin"), { force: true }); } catch (_) {} } }
function libAdd(o) {
  o = o || {};
  const s = shares.get(String(o.sid));
  const size = Math.floor(+o.size), psize = Math.floor(+o.psize);
  if (!s || !validKey(o.key) || !isHex(o.root, 64) || !/^[0-9a-f]{8,64}$/.test(String(o.id || "")) || size !== s.size) return false;
  if (!(psize >= 65536 && psize <= (64 << 20) && (psize & (psize - 1)) === 0)) return false;
  const n = Math.ceil(size / psize), hb = o.hashes;
  if (!hb || (hb.byteLength || hb.length) !== n * 32) return false;
  const hbuf = hb.buffer ? Buffer.from(hb.buffer, hb.byteOffset, hb.byteLength) : Buffer.from(hb);
  if (crypto.createHash("sha256").update(hbuf).digest("hex") !== o.root) return false;
  try { fs.mkdirSync(LIB_DIR, { recursive: true }); const hp = path.join(LIB_DIR, o.root + ".bin"); if (!fs.existsSync(hp)) fs.writeFileSync(hp, hbuf); } catch (_) { return false; }
  const j = libLoad();
  j.entries = j.entries.filter((e) => !(e.key === o.key && e.root === o.root));
  j.entries.push({ key: o.key, root: o.root, id: String(o.id), name: String(o.name || "arquivo").slice(0, 200), size, mime: String(o.mime || "").slice(0, 100), psize,
    kind: o.kind === "sent" ? "sent" : "got", path: s.path, mtimeMs: s.mtimeMs, ts: Date.now() });
  const mine = j.entries.filter((e) => e.key === o.key);
  if (mine.length > 300) { const drop = mine.sort((a, b) => a.ts - b.ts).slice(0, mine.length - 300); j.entries = j.entries.filter((e) => !drop.includes(e)); drop.forEach((e) => libDropHashes(j, e.root)); }
  knownFiles.add(normP(s.path)); libSave(j); return true;
}
function libList(key) {
  if (!validKey(key)) return [];
  const j = libLoad(), out = [], gone = [];
  for (const e of j.entries) {
    if (e.key !== key) continue;
    let st = null; try { st = fs.statSync(e.path); } catch (_) {}
    if (!st || !st.isFile() || st.size !== e.size || Math.abs(st.mtimeMs - e.mtimeMs) > 2) { gone.push(e); continue; }
    knownFiles.add(normP(e.path));
    out.push({ root: e.root, id: e.id, name: e.name, size: e.size, mime: e.mime, psize: e.psize, kind: e.kind, ts: e.ts, sid: addShare(e.path, st), path: e.path });
  }
  if (gone.length) { j.entries = j.entries.filter((e) => !gone.includes(e)); gone.forEach((e) => libDropHashes(j, e.root)); libSave(j); }
  return out;
}
function libRemove(key, root, kind) {
  if (!validKey(key)) return false;
  const j = libLoad(), drop = j.entries.filter((e) => e.key === key && (!root || e.root === root) && (!kind || e.kind === kind));
  if (!drop.length) return false;
  j.entries = j.entries.filter((e) => !drop.includes(e)); drop.forEach((e) => libDropHashes(j, e.root)); libSave(j); return true;
}
function libKeys() { const out = {}; for (const e of libLoad().entries) { const k = out[e.key] || (out[e.key] = { n: 0, bytes: 0 }); k.n++; k.bytes += e.size; } return out; }

// ---------- identidade: o código de amigo vem de uma chave criada neste PC (ninguém consegue se passar por você) ----------
const ID_FILE = path.join(app.getPath("userData"), "identidade.json");
let ident = null;
function identity() {
  if (ident) return ident;
  try { const j = JSON.parse(fs.readFileSync(ID_FILE, "utf8")); ident = { key: crypto.createPrivateKey(j.priv), pub: String(j.pub) }; return ident; } catch (_) {}
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" });
  try { fs.writeFileSync(ID_FILE, JSON.stringify({ v: 1, pub, priv }), { mode: 0o600 }); } catch (_) {}
  ident = { key: kp.privateKey, pub }; return ident;
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
function send(channel, ...args) { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); }
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
// ---------- abertura (logo + barra) e tamanho da janela: pequena pra entrar, grande na sala ----------
const THEME_COLORS = { grafite: { bg: "#20252d", track: "#303843", bar: "#99f1b6" }, creme: { bg: "#f4ecdc", track: "#e2d6bf", bar: "#1b7349" }, noite: { bg: "#121722", track: "#212938", bar: "#8fd0ff" } };
function themeColors() { return THEME_COLORS[readCfg().theme] || THEME_COLORS.grafite; }
let splash = null, splashP = 0, splashStart = 0, appShown = false;
function createSplash() {
  const c = themeColors();
  splashStart = Date.now();
  splash = new BrowserWindow({ width: 300, height: 320, frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false,
    backgroundColor: c.bg, title: "Tátão", icon: path.join(__dirname, "icon.ico"), webPreferences: { contextIsolation: true, nodeIntegration: false } });
  splash.loadFile(path.join(__dirname, "splash.html"), { query: { bg: c.bg, track: c.track, bar: c.bar } });
  splash.once("ready-to-show", () => { if (splash && !appShown) { splash.show(); splashProgress(splashP || 0.12); } });
  splash.on("closed", () => { splash = null; });
}
function splashProgress(p) {
  splashP = Math.max(splashP, p);
  if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript("window.setP&&setP(" + splashP + ")").catch(() => {});
}
function revealMain() {
  if (appShown || !win || win.isDestroyed()) return;
  appShown = true; splashProgress(1);
  const wait = Math.max(0, 900 - (Date.now() - splashStart)); // a abertura fica pelo menos ~1 s, pra não piscar
  setTimeout(() => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    setTimeout(() => { try { if (splash && !splash.isDestroyed()) splash.close(); } catch (_) {} }, 150);
  }, wait + 260);
}
const LOGIN_W = 480;
let winMode = null, loginH = 560;
const WINSTATE = path.join(app.getPath("userData"), "window.json");
function readWinState() { try { return JSON.parse(fs.readFileSync(WINSTATE, "utf8")); } catch (_) { return null; } }
function saveWinState() {
  if (!win || win.isDestroyed() || winMode !== "full") return;
  try { fs.writeFileSync(WINSTATE, JSON.stringify({ bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(), max: win.isMaximized() })); } catch (_) {}
}
function visibleOnScreen(b) {
  try { const wa = screen.getDisplayMatching(b).workArea; return b.x < wa.x + wa.width - 80 && b.x + b.width > wa.x + 80 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 80; } catch (_) { return false; }
}
function setLoginMode(h) {
  if (!win || win.isDestroyed()) return;
  let maxH = 880;
  try { maxH = Math.min(880, screen.getDisplayMatching(win.getBounds()).workArea.height - 40); } catch (_) {}
  const H = Math.max(380, Math.min(maxH, Math.round(+h || loginH))); // mais alto que a tela: rola por dentro
  const fromFull = winMode !== "login";
  if (winMode === "full") saveWinState();
  const before = win.getBounds(), cx = before.x + before.width / 2, cy = before.y + before.height / 2;
  winMode = "login"; loginH = H;
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  win.setResizable(true); win.setMinimumSize(1, 1);
  win.setContentSize(LOGIN_W, H);
  win.setResizable(false); win.setMaximizable(false); win.setFullScreenable(false);
  if (fromFull) { // centraliza onde a janela estava
    const b = win.getBounds();
    if (appShown) win.setPosition(Math.round(cx - b.width / 2), Math.round(cy - b.height / 2)); else win.center();
  }
}
function setFullMode() {
  if (!win || win.isDestroyed() || winMode === "full") return;
  const before = win.getBounds(), cx = before.x + before.width / 2, cy = before.y + before.height / 2;
  winMode = "full";
  win.setResizable(true); win.setMaximizable(true); win.setFullScreenable(true);
  win.setMinimumSize(820, 560);
  const st = readWinState();
  if (st && st.bounds && visibleOnScreen(st.bounds)) win.setBounds(st.bounds);
  else { win.setSize(1280, 820); const b = win.getBounds(); win.setPosition(Math.max(0, Math.round(cx - b.width / 2)), Math.max(0, Math.round(cy - b.height / 2))); }
  if (st && st.max) win.maximize();
}

function createWindow() {
  if (!splash) createSplash();
  win = new BrowserWindow({
    width: LOGIN_W, height: loginH, useContentSize: true, resizable: false, maximizable: false, show: false,
    backgroundColor: ({ creme: "#f4ecdc", noite: "#121722" })[readCfg().theme] || "#20252d", autoHideMenuBar: true, title: "Tátão",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  splashProgress(0.2);
  win.loadFile(path.join(__dirname, "sala-lan.html"));
  win.webContents.once("dom-ready", () => splashProgress(0.7));
  setTimeout(revealMain, 12000); // se algo travar, mostra a janela mesmo assim
  let stTimer = null;
  const queueSave = () => { if (winMode !== "full") return; clearTimeout(stTimer); stTimer = setTimeout(saveWinState, 400); };
  win.on("resize", queueSave); win.on("move", queueSave);
  win.on("close", saveWinState);
  win.on("focus", () => { try { win.flashFrame(false); } catch (_) {} });
  // links externos abrem no navegador, não numa janela do app
  win.webContents.on("will-navigate", (e, url) => { if (!/sala-lan\.html/.test(String(url))) e.preventDefault(); });
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
    splashProgress(0.85);
    setTimeout(checkUpdate, 4000);
    const r = resumeArg(); if (r) send("lan:resume", r);
  });
  // saiu da sala (a tela recarrega): desliga a placa de rede
  win.webContents.on("did-start-loading", () => { if (lan.running) lanStop(); pcStop(); tunCloseAll(); mcWatchRoom = false; mcListenStop(); });
  setInterval(checkUpdate, 30 * 60 * 1000); // re-checa a cada 30 min
  win.on("closed", () => { win = null; try { if (splash && !splash.isDestroyed()) splash.close(); } catch (_) {} });
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
ipcMain.handle("lan:elevate", (_e, r) => elevateNow(r, win));
ipcMain.handle("app:setAlwaysAdmin", (_e, on) => ({ ok: setRunAsAdminFlag(!!on), admin: isAdmin() }));
ipcMain.handle("app:elevate", () => elevateNow(null, win));
ipcMain.on("lan:out", (_e, buf) => { try { lanWrite(buf); } catch (_) {} });
ipcMain.handle("file:open", (_e, o) => {
  try {
    const final = freePath(recvDir(), safeFileName(o && o.name));
    const tmp = final + ".part", fd = fs.openSync(tmp, "w"), id = ++xferSeq;
    xfers.set(id, { fd, tmp, final, size: Math.max(0, Math.floor(+(o && o.size) || 0)), written: 0, pending: 0, err: null, waiters: [] });
    return { ok: true, id, name: path.basename(final) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// cada pedaço já conferido é gravado no lugar dele (podem chegar fora de ordem, de pessoas diferentes)
ipcMain.on("file:writeAt", (_e, id, pos, buf) => {
  const x = xfers.get(id); if (!x || x.err || !buf) return;
  const len = buf.byteLength != null ? buf.byteLength : buf.length; pos = Math.floor(+pos);
  if (!(pos >= 0) || pos + len > x.size) { x.err = "pedaço fora do tamanho combinado"; return; }
  const b = buf.buffer ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : Buffer.from(buf);
  x.pending++;
  fs.write(x.fd, b, 0, b.length, pos, (err, n) => {
    x.pending--; if (err) x.err = String(err.message || err); else x.written += n;
    if (!x.pending) { const w = x.waiters; x.waiters = []; w.forEach((f) => f()); }
  });
});
ipcMain.handle("file:close", (_e, id, ok) => new Promise((resolve) => {
  const x = xfers.get(id); if (!x) { resolve({ ok: false, error: "sem arquivo" }); return; }
  xfers.delete(id);
  const fin = () => fs.close(x.fd, () => {
    if (!ok || x.err || x.written !== x.size) { fs.rm(x.tmp, { force: true }, () => resolve({ ok: false, error: x.err || (ok ? "arquivo incompleto" : "cancelado") })); return; }
    try {
      const final = fs.existsSync(x.final) ? freePath(path.dirname(x.final), path.basename(x.final)) : x.final;
      fs.renameSync(x.tmp, final);
      // marca como vindo da internet: o Windows avisa antes de abrir programas recebidos
      if (process.platform === "win32") { try { fs.writeFileSync(final + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\n"); } catch (_) {} }
      knownFiles.add(normP(final));
      const st = fs.statSync(final);
      resolve({ ok: true, path: final, name: path.basename(final), risky: RISKY_EXT.test(final), sid: addShare(final, st) });
    } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
  });
  if (x.pending) x.waiters.push(fin); else fin();
}));
ipcMain.handle("file:show", (_e, p) => { if (!allowedPath(p)) return false; shell.showItemInFolder(String(p)); return true; });
ipcMain.handle("file:open-path", async (_e, p) => {
  if (!allowedPath(p) || RISKY_EXT.test(String(p))) return "bloqueado";
  return shell.openPath(String(p));
});
ipcMain.handle("file:folder", () => { const d = recvDir(); shell.openPath(d); return d; });
ipcMain.handle("file:getDir", () => dirInfo());
ipcMain.handle("file:pickDir", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Onde salvar os arquivos recebidos", defaultPath: dirInfo().dir, buttonLabel: "Usar esta pasta",
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"] });
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  try { fs.mkdirSync(r.filePaths[0], { recursive: true }); fs.accessSync(r.filePaths[0], fs.constants.W_OK); } catch (_) { return { error: "Não dá pra salvar nessa pasta." }; }
  setRecvDir(r.filePaths[0]); return dirInfo();
});
ipcMain.handle("file:resetDir", () => { setRecvDir(null); return dirInfo(); });
// o caminho vem do próprio arquivo escolhido (pelo preload), nunca de texto da página
ipcMain.handle("file:reg", async (_e, p) => {
  try { p = String(p || ""); if (!p || !path.isAbsolute(p)) return null; const st = await fs.promises.stat(p); if (!st.isFile()) return null; return { sid: addShare(p, st), size: st.size }; } catch (_) { return null; }
});
ipcMain.handle("file:read", async (_e, sid, pos, len) => { try { return await shareRead(sid, pos, len); } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle("file:unshare", (_e, sid) => { const s = shares.get(String(sid)); if (s) { if (s.fh) s.fh.close().catch(() => {}); shares.delete(String(sid)); } return true; });
ipcMain.handle("lib:add", (_e, o) => libAdd(o));
ipcMain.handle("lib:list", (_e, key) => libList(key));
ipcMain.handle("lib:hashes", (_e, root) => { if (!isHex(root, 64)) return null; try { return fs.readFileSync(path.join(LIB_DIR, root + ".bin")); } catch (_) { return null; } });
ipcMain.handle("lib:remove", (_e, key, root, kind) => libRemove(key, root && isHex(root, 64) ? root : null, kind === "got" || kind === "sent" ? kind : null));
ipcMain.handle("lib:keys", () => libKeys());
ipcMain.handle("id:get", () => ({ pub: identity().pub }));
ipcMain.handle("id:sign", (_e, txt) => {
  const s = String(txt || ""); if (!/^tatao-pres\|/.test(s) || s.length > 300) return null; // só assina o desafio dos amigos
  return crypto.sign("sha256", Buffer.from(s, "utf8"), { key: identity().key, dsaEncoding: "ieee-p1363" }).toString("base64");
});
ipcMain.on("win:attention", () => { try { if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true); } catch (_) {} });
ipcMain.handle("music:resolve", (_e, url) => deezerResolve(url).catch((e) => ({ ok: false, error: "Não consegui falar com o Deezer agora." })));
ipcMain.handle("music:search", (_e, o) => ytSearch(o).catch(() => ({ ok: false, error: "net" })));
ipcMain.handle("music:keyInfo", () => ({ has: !!ytKey(), user: !!userYtKey(), app: !!String(appKeys().ytKey || "").trim() }));
ipcMain.handle("music:testKey", (_e, k) => ytTestKey(k));
ipcMain.on("win:mode", (_e, o) => { o = o || {}; if (o.mode === "full") setFullMode(); else setLoginMode(o.h); });
ipcMain.on("app:ready", () => revealMain());
ipcMain.handle("app:isAdmin", () => process.platform === "win32" ? isAdmin() : null);
ipcMain.on("theme:bg", (_e, c) => { try { if (win && !win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(String(c))) win.setBackgroundColor(String(c)); } catch (_) {} });
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
    const target = /^https:\/\/(www\.)?youtube\.com\//.test(String(id)) ? String(id) : "https://youtu.be/" + String(id);
    https.get("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(target), { headers: { "User-Agent": "Tatao" } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); resolve(""); return; }
      let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { resolve((JSON.parse(d).title) || ""); } catch (_) { resolve(""); } });
    }).on("error", () => resolve(""));
  } catch (_) { resolve(""); }
}));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win && appShown) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    const always = process.platform === "win32" && !!readCfg().alwaysAdmin;
    if (process.platform === "win32") setRunAsAdminFlag(always); // mantém a marca do Windows igual à opção (e no caminho atual do .exe)
    if (always && !process.argv.includes("--tatao-noelevate") && !isAdmin()) {
      createSplash();
      splash.once("show", () => setTimeout(() => {
        elevateNow(null, splash).then((r) => { if (!r.ok) createWindow(); });
      }, 250));
      return;
    }
    createWindow();
  });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", () => { stopPeerServer(); try { if (probeSrv) probeSrv.close(); } catch (_) {} lanStop(); pcStop(); tunCloseAll(); });
}
