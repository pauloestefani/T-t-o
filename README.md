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

## Áudio do PC (Spotify ou qualquer app)
No painel **Música**, escolha o app (Spotify, navegador…) ou "Todo o som do PC" e clique em **Compartilhar áudio**. Os amigos ouvem em estéreo, com volume próprio. O `tatao-audio.exe` (código em `native/tatao-audio.cpp`, compilado pelo GitHub Actions) usa a captura por processo do Windows 10 2004+/11, então o som do próprio Tátão (as vozes da sala) nunca entra — isso também vale pro som da transmissão de tela.

## Arquivos
Na **Resenha**, clique no clipe, arraste arquivos pra janela ou cole (Ctrl+V). Pra mandar só pra uma pessoa, use o menu "⋯" dela → "Mandar arquivo só pra essa pessoa".
- O arquivo vai direto de um PC pro outro (WebRTC, sem servidor e sem limite de tamanho) e fica disponível enquanto quem mandou estiver na sala.
- Só quem está na sala consegue pedir um arquivo; o anfitrião repassa só o anúncio, nunca o conteúdo.
- No app, o arquivo é gravado direto no disco em `Downloads\Tátão` (sem sobrescrever nada) e marcado como vindo da internet, então o Windows avisa antes de rodar um programa recebido. O botão "Abrir" não aparece para programas e scripts (.exe, .bat, .ps1…); pra esses só há "Mostrar na pasta".

## Música: YouTube e Deezer
Cole no painel **Música** um link de música ou playlist do **YouTube** (inclusive YouTube Music) ou do **Deezer**. Tudo toca no player oficial do YouTube, visível e sincronizado pra sala.
- Playlist do YouTube: o próprio player oficial abre a lista (sem chave).
- Deezer: a API pública do Deezer dá os nomes; cada música é procurada no YouTube só quando vai tocar (e a próxima). Isso usa a **YouTube Data API v3** e precisa de uma chave grátis (≈100 buscas/dia). Coloque em Configurações → Música, ou crie o segredo `YT_API_KEY` no GitHub (Settings → Secrets and variables → Actions) pra ela já vir no app.
- Spotify: não é convertido, porque a política de desenvolvedores do Spotify proíbe tocar o catálogo dele por outro serviço. Use "Áudio do seu PC".

## Auto-update
O app lê `resources/update.json` (campo `repo`) e, ao abrir, checa o último **Release** deste GitHub. Se a tag for maior que a versão instalada, baixa o `.zip` anexado, troca os arquivos e reinicia. Veja `COMO-ATUALIZAR.txt`.

> Deixe o app numa pasta com permissão de escrita (Desktop, Documentos). Evite `C:\Program Files`.
