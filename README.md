# R-Observe

Repositorio operacional da stack `r-observe`, separado de `infra`.

## Diretorio operacional

O diretorio de trabalho e deploy deste projeto e `/opt/results/r-observe`.

## Conteudo

- aplicacao `r-observe/`
- stack observability/monitoring em `observe/`
- compose e env do produto
- scripts de dev, deploy, discovery e release
- testes E2E em `tests/e2e`
- documentacao em `docs/`

## Comandos principais

- `npm run observe:up`
- `npm run observe:up:full`
- `npm run observe:down`
- `npm run observe:health`
- `npm run observe:validate`
- `npm run discovery:test`
- `npm run release:gate`

## Documentacao

- `docs/README.md`
- `docs/observe/docker-compose.md`
- `docs/observe/architecture.md`
- `docs/observe/migrations.md`
- `docs/r-observe-discovery/README.md`
