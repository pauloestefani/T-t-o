const packager = require("@electron/packager");
(async () => {
  const out = await packager({
    dir: __dirname,
    name: "Sala LAN",
    platform: "win32",
    arch: "x64",
    out: "dist",
    overwrite: true,
    asar: true,
    prune: true,
    icon: "icon.ico",
    appVersion: "1.3.0",
    appCopyright: "Sala LAN",
    win32metadata: {
      CompanyName: "Sala LAN",
      FileDescription: "Sala LAN - voz, tela e chat para jogar em LAN",
      ProductName: "Sala LAN"
    },
    electronVersion: "31.7.6",
    ignore: [/^\/dist($|\/)/, /^\/build\.js$/, /package-lock\.json/, /^\/COMO-ATUALIZAR/, /(^|\/)_[^/]*$/]
  });
  console.log("OUT=" + out);
})().catch((e) => { console.error("BUILD_FAIL", e); process.exit(1); });
