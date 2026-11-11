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

**Minecraft (Java):** ao "Abrir para LAN" (ou com um servidor do Minecraft rodando no PC), o Tátão percebe o mundo sozinho: ele olha quais portas o Java está escutando e confirma com o "ping de status" do próprio Minecraft, sem depender do aviso de rede do jogo. No PC de cada amigo, o mundo aparece sozinho em Multijogador (parte de LAN), apontando pro túnel. Cada amigo recebe no chat (e em **Rede LAN → Mundos abertos na rede**) um endereço `127.0.0.1:porta` pra usar em **Multijogador → Conexão direta**: o Tátão do amigo abre essa porta só no PC dele e leva a conexão até o Minecraft de quem abriu o mundo pela própria conexão da sala. Não precisa de rede LAN ligada, VPN nem liberar firewall. Quem abriu o mundo só aceita ligar pra portas de mundos abertos no próprio PC. Se o Tátão não perceber o mundo sozinho, em **Rede LAN → Jogos abertos pela sala** dá pra digitar a porta do jogo (ex.: a porta que o Minecraft mostra ao abrir pra LAN) e compartilhar; o "Parar" tira na hora. O aviso do Minecraft (224.0.2.60) também passa a sair pela placa do Tátão enquanto a rede está ligada, e a placa é marcada como rede **Privada** (o app tenta de novo até o Windows aceitar).

O `wintun.dll` não fica no repositório: o build do GitHub Actions baixa a versão oficial assinada. Pra build local, coloque `wintun.dll` (amd64) e `LICENSE.txt` em `vendor/` como `vendor/wintun.dll` e `vendor/wintun-LICENSE.txt`.

## Áudio do PC (Spotify ou qualquer app)
No painel **Música**, escolha o app (Spotify, navegador…) ou "Todo o som do PC" e clique em **Compartilhar áudio**. Os amigos ouvem em estéreo, com volume próprio. O `tatao-audio.exe` (código em `native/tatao-audio.cpp`, compilado pelo GitHub Actions) usa a captura por processo do Windows 10 2004+/11, então o som do próprio Tátão (as vozes da sala) nunca entra — isso também vale pro som da transmissão de tela.

## Servidores, amigos e chamada
Na tela inicial:
- **Servidores**: crie um servidor (nome, código e senha) e mande o **convite** (`tatao:…`) pros amigos; quem colar em **Colar convite** ganha o servidor salvo. Cada servidor mostra se está online e quantas pessoas tem (a contagem só aparece pra quem tem a senha certa). Qualquer um da turma abre o servidor: quem entrar primeiro vira o anfitrião, e se o anfitrião sair, quem ficou reabre sozinho em poucos segundos.
- **Seu código de amigo** (ex.: `Paulo#K7Q2MX`) fica embaixo do seu nome. O nome pode repetir; o código vem de uma chave criada no seu PC (`identidade.json` na pasta de dados do app), então ninguém consegue se passar por você.
- **Amigos**: adicione pelo código ou pelo menu "⋯" de quem estiver na sala. O outro precisa aceitar. A lista mostra quem está com o Tátão aberto.
- **Chamar**: chama um amigo pro servidor (toca o som de chamada); ele escolhe Entrar ou Recusar. Dentro da sala, use "Chamar amigo".

## Arquivos (estilo torrent)
Na **Resenha**, clique no clipe, arraste arquivos pra janela ou cole (Ctrl+V). Pra mandar só pra uma pessoa, use o menu "⋯" dela → "Mandar arquivo só pra essa pessoa".
- Quem manda gera uma impressão digital (SHA-256) de cada pedaço. Quem baixa pega pedaços de até 4 pessoas ao mesmo tempo e confere cada um antes de gravar; pedaço diferente é descartado e quem mandou ele deixa de ser usado.
- Depois de baixar, o app pergunta **"Ajudar a compartilhar?"**. A escolha vale por servidor ("Lembrar minha escolha neste servidor") e muda em Ajustes → Arquivos. Quem compartilha serve o arquivo enquanto estiver no servidor, mesmo que quem mandou já tenha saído. Os arquivos compartilhados ficam numa biblioteca (`biblioteca/` na pasta de dados) e voltam a ficar disponíveis quando a pessoa entra de novo no servidor. Quem chega depois recebe a lista dos arquivos disponíveis.
- Arquivos privados nunca são compartilhados por quem recebe.
- Os arquivos vão direto pra pasta escolhida em **Ajustes → Arquivos** (padrão `Downloads\Tátão`), sem perguntar e sem sobrescrever nada, e são marcados como vindos da internet: o Windows avisa antes de rodar um programa recebido. O botão "Abrir" não aparece para programas e scripts (.exe, .bat, .ps1…).
- Só quem está na sala consegue pedir um arquivo; o anfitrião repassa só os anúncios, nunca o conteúdo.

## Música: YouTube e Deezer
Cole no painel **Música** um link de música ou playlist do **YouTube** (inclusive YouTube Music) ou do **Deezer**. Tudo toca no player oficial do YouTube, visível e sincronizado pra sala.
- Playlist do YouTube: o próprio player oficial abre a lista (sem chave).
- Deezer: a API pública do Deezer dá os nomes; cada música é procurada no YouTube só quando vai tocar (e a próxima). Isso usa a **YouTube Data API v3** e precisa de uma chave grátis (≈100 buscas/dia). Coloque em Configurações → Música, ou crie o segredo `YT_API_KEY` no GitHub (Settings → Secrets and variables → Actions) pra ela já vir no app.
- Spotify: não é convertido, porque a política de desenvolvedores do Spotify proíbe tocar o catálogo dele por outro serviço. Use "Áudio do seu PC".

## Auto-update
O app lê `resources/update.json` (campo `repo`) e, ao abrir, checa o último **Release** deste GitHub. Se a tag for maior que a versão instalada, baixa o `.zip` anexado, troca os arquivos e reinicia. Veja `COMO-ATUALIZAR.txt`.

> Deixe o app numa pasta com permissão de escrita (Desktop, Documentos). Evite `C:\Program Files`.
