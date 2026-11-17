# Tátão — regras do projeto

- Versão: mudança pequena sobe o último número (1.x.**y**); mudança grande sobe o do meio (1.**x**.0).
- Toda versão publicada tem a parte dela no `CHANGELOG.md` (seção `## X.Y.Z — dd/mm/aaaa` no topo, em português, do jeito que a pessoa que usa o app entende). O GitHub Actions não publica sem isso, e o texto vira a página do Release e o "O que mudou" dentro do app.
- A versão fica em `package.json` e em `var APP_VERSION` no `sala-lan.html`.
- Cada push na `main` com versão nova gera `Tatao-Windows.zip` e `Tatao-Linux.AppImage` e publica os dois juntos; os apps se atualizam sozinhos.
