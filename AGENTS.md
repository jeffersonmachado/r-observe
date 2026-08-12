# Regras operacionais do R-Observe

## Deploy remoto obrigatoriamente por imagens locais

- Imagens Docker do R-Observe devem ser construidas e validadas no computador local.
- O deploy em servidor remoto deve comparar os IDs de conteudo local/remoto e transferir somente imagens ausentes ou desatualizadas com `docker save`/`docker load` (ou registry explicitamente aprovado), iniciando o Compose com `--no-build --pull never`.
- E proibido executar `docker compose build`, `docker build` ou compilacoes equivalentes no servidor de producao.
- O fluxo canonico e `npm run observe:deploy:images`; ele sincroniza apenas arquivos alterados sem sobrescrever `.env.observe` ou `secrets/`, transfere apenas imagens alteradas e sobe a stack sem build remoto.
- `--skip-build` apenas reutiliza imagens locais ja existentes; nunca significa construir remotamente.
- Antes de concluir um deploy, validar Compose, imagens locais, arquitetura local/remota, containers, healthcheck e smoke test. Nunca exibir senhas ou chaves nos logs.

## Versões da stack (`/observe/versions`)

- A página de versões (`/observe/versions`) é alimentada por `r-observe/api/src/stack-versions.json`, gerado pelo script `scripts/observe/update-stack-versions.js`.
- **Sempre que alterar a versão de qualquer imagem no `docker-compose.observe.yml` ou nos Dockerfiles (FROM/ARG `*_VERSION`), execute `npm run observe:update-versions` e commite o `stack-versions.json` atualizado.**
- Não edite `stack-versions.json` manualmente; para adicionar/remover um componente na página, edite o catálogo `CATALOG` dentro do próprio script e rode-o.
- Detalhes em `docs/observe/stack-versions.md`.
