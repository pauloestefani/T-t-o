// Build do Tátão (Windows). Monta um stage limpo (só deps de runtime) e empacota.
// Roda igual aqui e no GitHub Actions. A versão vem do package.json.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const packager = require("@electron/packager");

const ROOT = __dirname;
const STAGE = path.join(ROOT, ".stage");
const pkg = require("./package.json");

// 1) stage limpo com os arquivos do app
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const f of ["main.js", "preload.js", "sala-lan.html", "icon.ico", "update.json"]) {
  fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
}
fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify({
  name: "tatao", productName: "Tátão", version: pkg.version, main: "main.js",
  dependencies: pkg.dependencies || {}
}, null, 2));

// 2) instala só as dependências de runtime (peer, extract-zip)
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

// 4) empacota Windows x64
(async () => {
  const out = await packager({
    dir: STAGE, name: "Tatao", platform: "win32", arch: "x64",
    out: path.join(ROOT, "dist"), overwrite: true, asar: true, prune: false,
    icon: path.join(ROOT, "icon.ico"),
    extraResource: [path.join(ROOT, "update.json")],
    appVersion: pkg.version, appCopyright: "Tatao",
    win32metadata: { CompanyName: "Tatao", FileDescription: "Tátão - voz, tela, chat e música", ProductName: "Tátão" },
    electronVersion: "31.7.6"
  });
  console.log("OUT=" + out);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
