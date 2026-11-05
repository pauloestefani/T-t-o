# Tátão

App de desktop (Windows) pra jogar em LAN com os amigos: **voz em grupo, compartilhamento de tela, chat e jukebox de YouTube sincronizado** — tudo P2P (WebRTC).

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

## Auto-update
O app lê `resources/update.json` (campo `repo`) e, ao abrir, checa o último **Release** deste GitHub. Se a tag for maior que a versão instalada, baixa o `.zip` anexado, troca os arquivos e reinicia. Veja `COMO-ATUALIZAR.txt`.

> Deixe o app numa pasta com permissão de escrita (Desktop, Documentos). Evite `C:\Program Files`.
