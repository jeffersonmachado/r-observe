# Modelo de dados Discovery

## Contrato de schema

- O schema do `r-observe` e gerido por migrations SQL em `r-observe/migrations/`.
- A execucao dessas migrations acontece pelo fluxo oficial `Sequelize` + `Umzug`, implementado em `r-observe/api/src/migrate.js` e `r-observe/discovery/src/migrate.js`.
- Constraints, `UNIQUE INDEX`, ajustes de integridade e backfills de dados devem entrar nessas migrations versionadas.
- Nao tratamos constraint como ajuste manual permanente no banco; quando houver intervencao operacional, ela precisa virar migration e ficar documentada no repositorio.

Tabelas novas criadas na migration 004:

- `observe_discovery_policies`
- `observe_discovery_targets`
- `observe_discovery_runs`
- `observe_assets`
- `observe_asset_interfaces`
- `observe_asset_services`
- `observe_discovery_findings`
- `observe_service_fingerprints`
- `observe_topology_edges`
- `observe_dependencies`
- `observe_asset_changes`
- `observe_asset_history`

## Separacao de responsabilidades

- `observe_hosts`/`observe_services`: monitoramento legado e compatibilidade.
- `observe_assets` e demais: inventario discovery enterprise.

## Estados de ciclo de vida do asset

- `discovered`
- `approved`
- `monitored`
- `ignored`
- `quarantined`
- `disappeared`

## Constraints relevantes de deduplicacao

- `observe_asset_interfaces`: `UNIQUE (tenant_id, site_id, edge_id, asset_id, interface_key)` em `r-observe/migrations/004_discovery_engine.sql`.
- `observe_asset_services`: `UNIQUE (tenant_id, site_id, edge_id, asset_id, service_key)` em `r-observe/migrations/004_discovery_engine.sql`.
- `observe_service_fingerprints`: `uq_observe_service_fingerprints_key` em `r-observe/migrations/008_fingerprint_dedup.sql`.
- `observe_topology_edges`: `uq_observe_topology_edges_dedupe` em `r-observe/migrations/005_discovery_dedupe_indexes.sql`.
- Consolidacao historica de duplicatas logicas de `observe_assets`: `r-observe/migrations/006_discovery_logical_asset_dedupe.sql`.
