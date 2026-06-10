# Arquitetura do r-observe-discovery

## Objetivo

Evoluir o R-Observe para um `Continuous Autonomous Discovery Engine` com descoberta ativa/passiva, inventario vivo, fingerprinting, topologia operacional e integracoes com observabilidade e monitoramento.

## Componentes

- `r-observe-discovery` (novo servico Node): engine de discovery e APIs.
- `r-observe-api` (existente): compatibilidade e proxy para discovery.
- `r-observe-worker` (existente): continua processamento de eventos e AIOps.
- Redis (existente): event bus e fila.
- PostgreSQL (existente): persistencia de assets/runs/findings/topologia.
- Prometheus (existente): ingestao de targets dinamicos via HTTP SD e File SD.
- Icinga (existente): onboarding controlado de ativos aprovados.

## Fluxo principal

1. Policy e targets definem escopo e limites.
2. Discovery run inicia e emite `observe.discovery.started`.
3. Scanner ativo executa perfil (`safe` por padrao).
4. Fingerprint engine classifica asset/servicos.
5. Inventario e findings sao persistidos.
6. Drift detector registra mudancas em `observe_asset_changes`.
7. Topology engine cria edges operacionais.
8. Prometheus SD e atualizado.
9. Eventos de conclusao e mudanca sao emitidos.
10. Integracao Icinga aplica apenas para estados aprovados.

## Multi-tenant

Todas as entidades discovery usam:
- `tenant_id`
- `site_id`
- `edge_id`

## Segurança

- Perfil default `safe`.
- Rate limit por API.
- Guardrails por `allowlist` e `blocklist`.
- Throttling por politica e `max_rate_per_minute`.
- Sem scans agressivos por default.

## Observabilidade

- `/metrics` com `prom-client`.
- logs estruturados JSON.
- OTel auto-instrumentation para HTTP/PG/Redis.

## Compatibilidade

Nao removeu funcionalidade existente de:
- Icinga
- Prometheus
- Loki
- Grafana
- OTel
- API atual
- workers atuais
