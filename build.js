// Build do Tátão. Monta um stage limpo (só deps de runtime) e empacota.
//   node build.js          -> Windows x64 (dist/Tatao-win32-x64)
//   node build.js linux    -> Linux x64   (dist/Tatao-linux-x64; o AppImage sai do build-appimage.sh)
// Roda igual aqui e no GitHub Actions. A versão vem do package.json.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const packager = require("@electron/packager");

const ROOT = __dirname;
const STAGE = path.join(ROOT, ".stage");
const pkg = require("./package.json");
const PLATFORM = process.argv[2] === "linux" ? "linux" : "win32";
const KOFFI = PLATFORM === "linux" ? "linux_x64" : "win32_x64";

// 1) stage limpo com os arquivos do app
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const f of ["main.js", "preload.js", "lan-worker.js", "sala-lan.html", "splash.html", "icon.ico", "icon.png", "update.json", "CHANGELOG.md"]) {
  fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
}
fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify({
  name: "tatao", productName: "Tátão", version: pkg.version, main: "main.js",
  desktopName: "tatao.desktop", // Linux: liga a janela ao atalho do menu (ícone certo na barra de tarefas)
  dependencies: pkg.dependencies || {}
}, null, 2));

// 2) instala só as dependências de runtime (peer, extract-zip, koffi)
console.log("Instalando dependências de produção no stage…");
cp.execSync("npm install --omit=dev --no-audit --no-fund --no-package-lock", { cwd: STAGE, stdio: "inherit" });

// 3) remove o que não é usado em runtime (tipos TS, source maps, docs) pra reduzir tamanho
function clean(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === "@types" || e.name === "undici-types") fs.rmSync(f, { recursive: true, force: true }); else clean(f); }
    else if (/\.(d\.ts|map|md)$/i.test(e.name)) fs.rmSync(f, { force: true });
  }
}
clean(path.join(STAGE, "node_modules"));

// 4) recursos que ficam soltos ao lado do app (precisam ser arquivos de verdade)
const extra = [path.join(ROOT, "update.json")];
if (PLATFORM === "win32") {
  for (const f of ["wintun.dll", "wintun-LICENSE.txt", "tatao-audio.exe"]) {
    const p = path.join(ROOT, "vendor", f);
    if (fs.existsSync(p)) extra.push(p); else console.log("aviso: vendor/" + f + " não encontrado (a rede LAN ou o áudio do PC não vão funcionar neste build)");
  }
}
// chave do YouTube que o GitHub coloca no build (segredo YT_API_KEY); sem ela, cada um pode pôr a sua nas Configurações
if (fs.existsSync(path.join(ROOT, "vendor", "keys.json"))) extra.push(path.join(ROOT, "vendor", "keys.json"));

// 5) empacota
(async () => {
  const kre = new RegExp("^/node_modules/koffi/build/koffi/(?!" + KOFFI + ")");
  const out = await packager({
    dir: STAGE, name: "Tatao", platform: PLATFORM, arch: "x64",
    executableName: PLATFORM === "linux" ? "tatao" : "Tatao",
    out: path.join(ROOT, "dist"), overwrite: true, prune: false,
    // koffi e a thread da rede ficam fora do .asar: binários nativos e workers precisam de arquivos reais
    asar: { unpack: "**/lan-worker.js", unpackDir: "node_modules/koffi" },
    // da koffi, só o binário desta plataforma e o código que ela carrega
    ignore: [kre, /^\/node_modules\/koffi\/(src|vendor|doc)(\/|$)/],
    icon: path.join(ROOT, "icon.ico"),
    extraResource: extra,
    appVersion: pkg.version, appCopyright: "Tatao",
    win32metadata: { CompanyName: "Tatao", FileDescription: "Tátão - voz, tela, chat, música e rede LAN", ProductName: "Tátão" },
    electronVersion: "31.7.6"
  });
  console.log("OUT=" + out);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
