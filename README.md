# Tátão

App de desktop (Windows) pra jogar em LAN com os amigos: **voz em grupo, compartilhamento de tela, chat, jukebox de YouTube sincronizado e rede LAN própria** (tipo Radmin, sem precisar do Radmin) — tudo P2P (WebRTC).

## Rodar em dev
```
npm install
npm start
```

## Gerar o .exe
```
npm install
node build.js      # sai em dist/Tatao-win32-x64/
```
Zipe a pasta `dist/Tatao-win32-x64` como `Tatao-Windows.zip`.

## Rede LAN própria (beta)
Na aba **Rede LAN**, o Tátão cria uma placa de rede virtual (`TataoLAN`, via [Wintun](https://www.wintun.net/)) e dá a cada pessoa da sala um IP `10.77.x.x` — o host é sempre `10.77.0.1`. Os pacotes dos jogos passam direto entre os PCs pela conexão P2P da sala. Ligar a rede pede permissão de administrador uma vez por abertura do app.

O `wintun.dll` não fica no repositório: o build do GitHub Actions baixa a versão oficial assinada. Pra build local, coloque `wintun.dll` (amd64) e `LICENSE.txt` em `vendor/` como `vendor/wintun.dll` e `vendor/wintun-LICENSE.txt`.

## Auto-update
O app lê `resources/update.json` (campo `repo`) e, ao abrir, checa o último **Release** deste GitHub. Se a tag for maior que a versão instalada, baixa o `.zip` anexado, troca os arquivos e reinicia. Veja `COMO-ATUALIZAR.txt`.

> Deixe o app numa pasta com permissão de escrita (Desktop, Documentos). Evite `C:\Program Files`.
