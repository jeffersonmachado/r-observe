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
- `npm run observe:deploy:images` (build local + Docker save/load; nunca compila no servidor)
- `npm run discovery:test`
- `npm run release:gate`

## Primeiro uso

1. Copie `.env.observe.example` para `.env.observe` e preencha todos os valores
   marcados como obrigatórios, especialmente `ICINGAWEB_ADMIN_PASS` e as senhas
   de PostgreSQL e Redis.
2. Valide a configuração com `npm run observe:validate`.
3. Inicie a stack com `npm run observe:up` ou todos os perfis com
   `npm run observe:up:full`.
4. Confirme a saúde com `npm run observe:health`.
5. Abra `http://localhost:3080/`. O produto encaminha para o login e, após a
   autenticação, para a home operacional.

O usuário inicial é definido por `ICINGAWEB_ADMIN_USER` e a senha por
`ICINGAWEB_ADMIN_PASS`. Não use os valores de exemplo em ambientes reais.

Para executar os testes E2E com um Chromium já instalado no sistema, defina
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` com o caminho do executável. Sem essa variável,
o Playwright usa o navegador gerenciado por `npx playwright install`.

## Documentacao

- `docs/README.md`
- `docs/observe/docker-compose.md`
- `docs/observe/architecture.md`
- `docs/observe/migrations.md`
- `docs/observe/deploy-remote-images.md`
- `docs/r-observe-discovery/README.md`
