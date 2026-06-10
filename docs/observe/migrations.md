# Migrations do R-Observe

Guia operacional curto para evolucao de schema no `r-observe`.

## Stack usada

- O acesso ao PostgreSQL usa `Sequelize` como client.
- A execucao de migrations usa `Umzug`.
- As migrations ficam versionadas em `r-observe/migrations/*.sql`.
- Os runners oficiais estao em `r-observe/api/src/migrate.js` e `r-observe/discovery/src/migrate.js`.

## Regra de ouro

- Constraint, `UNIQUE INDEX`, ajuste de integridade e backfill estrutural devem entrar em migration versionada.
- Nao deixar mudanca de schema apenas como ajuste manual no banco.
- Se houve intervencao emergencial em producao, ela precisa ser convertida em migration e documentada no repositorio.

## Quando criar migration

- Nova tabela, coluna, indice ou constraint.
- Mudanca de chave de deduplicacao.
- Backfill necessario para suportar nova constraint.
- Correcao de dados historicos que passa a fazer parte do comportamento esperado do sistema.

## Como nomear

- Use prefixo numerico crescente em `r-observe/migrations/`.
- Nomeie pelo efeito, nao pela urgencia.
- Exemplos:
  - `014_assets_lifecycle_ttl.sql`
  - `015_normalize_discovery_hostnames.sql`

## Como implementar

- Prefira SQL idempotente quando viavel: `IF NOT EXISTS`, `ON CONFLICT`, `ADD COLUMN IF NOT EXISTS`.
- Se uma nova constraint puder colidir com dados antigos, faca o backfill na mesma migration ou em migration imediatamente anterior.
- Antes de reatribuir FKs, deduplique tabelas filhas que tenham `UNIQUE` baseado na chave antiga.
- Evite misturar mudancas de schema sem relacao na mesma migration.

## Fluxo recomendado

1. Escrever a migration em `r-observe/migrations/`.
2. Revisar impacto em constraints, FKs e volume de dados historicos.
3. Validar em transacao com `BEGIN ... ROLLBACK` quando a migration permitir.
4. Executar localmente pelo runner oficial ou via `psql` controlado em ambiente de validacao.
5. Registrar o contrato na documentacao se a mudanca alterar comportamento operacional.

## Validacao local

Para ensaio sem persistir mudancas:

```bash
cd /opt/results/r-observe
{ printf 'BEGIN;\n'; cat r-observe/migrations/006_discovery_logical_asset_dedupe.sql; printf '\nROLLBACK;\n'; } \
  | docker exec -i r-observe-postgres psql -v ON_ERROR_STOP=1 -U observe -d observedb
```

Para aplicar uma migration SQL diretamente no banco local:

```bash
cd /opt/results/r-observe
docker exec -i r-observe-postgres psql -v ON_ERROR_STOP=1 -U observe -d observedb \
  < r-observe/migrations/006_discovery_logical_asset_dedupe.sql
```

## Execucao pelo runner oficial

API:

```bash
cd /opt/results/r-observe/r-observe/api
node src/migrate.js
```

Discovery:

```bash
cd /opt/results/r-observe/r-observe/discovery
node src/migrate.js
```

## Checklist de review

- A migration e segura para reexecucao ou falha de forma previsivel?
- Existe risco de violar `UNIQUE` ao mover dados historicos?
- Todas as tabelas filhas afetadas por FK foram consideradas?
- Existe metrica ou consulta de antes/depois para provar o efeito?
- A documentacao do contrato foi atualizada?

## Referencias

- `r-observe/api/src/migrate.js`
- `r-observe/discovery/src/migrate.js`
- `docs/r-observe-discovery/05-database.md`
