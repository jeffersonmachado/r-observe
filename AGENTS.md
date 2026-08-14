# Regras operacionais do R-Observe

## Deploy remoto obrigatoriamente por imagens locais

- Imagens Docker do R-Observe devem ser construidas e validadas no computador local.
- O deploy em servidor remoto deve comparar os IDs de conteudo local/remoto e transferir somente imagens ausentes ou desatualizadas com `docker save`/`docker load` (ou registry explicitamente aprovado), iniciando o Compose com `--no-build --pull never`.
- E proibido executar `docker compose build`, `docker build` ou compilacoes equivalentes no servidor de producao.
- O fluxo canonico e `npm run observe:deploy:images`; ele sincroniza apenas arquivos alterados sem sobrescrever `.env.observe` ou `secrets/`, transfere apenas imagens alteradas e sobe a stack sem build remoto.
- `--skip-build` apenas reutiliza imagens locais ja existentes; nunca significa construir remotamente.
- Antes de concluir um deploy, validar Compose, imagens locais, arquitetura local/remota, containers, healthcheck e smoke test. Nunca exibir senhas ou chaves nos logs.

## Limites de recursos adaptativos

- Os limites de CPU/memória no `docker-compose.observe.yml` referenciam variáveis `OBSERVE_LIMIT_*` (com os valores atuais como default) — **não hardcode novos valores por serviço**.
- O script `scripts/observe/compute-resource-limits.sh` calcula os limites a partir das características do servidor (CPUs e RAM) e é executado automaticamente a cada deploy (`--write .env.observe`), usando como referência 4 CPUs / 16 GiB.
- Para testar/forçar manualmente: `OBSERVE_TOTAL_CPUS=8 OBSERVE_TOTAL_MEMORY_MB=32768 bash scripts/observe/compute-resource-limits.sh`.
- O worker usa o tier `OBSERVE_LIMIT_MEM_LG` (não `MEM_MD`): ele hospeda o Chromium do canal WhatsApp QR (whatsapp-web.js), que morre por OOM com 256M.

## Versões da stack (`/observe/versions`)

- A página de versões (`/observe/versions`) é alimentada por `r-observe/api/src/stack-versions.json`, gerado pelo script `scripts/observe/update-stack-versions.js`.
- **Sempre que alterar a versão de qualquer imagem no `docker-compose.observe.yml` ou nos Dockerfiles (FROM/ARG `*_VERSION`), execute `npm run observe:update-versions` e commite o `stack-versions.json` atualizado.**
- Não edite `stack-versions.json` manualmente; para adicionar/remover um componente na página, edite o catálogo `CATALOG` dentro do próprio script e rode-o.
- Detalhes em `docs/observe/stack-versions.md`.
