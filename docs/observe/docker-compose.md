# R-Observe — Docker Compose

## Arquivo principal

`docker-compose.observe.yml`

## Profiles

| Profile              | Serviços incluídos                                          |
|----------------------|-------------------------------------------------------------|
| `observe-core`       | postgres, redis, db-bootstrap (one-shot), r-observe-api, r-observe-worker, r-observe-discovery |
| `observe-ai`         | r-observe-ai                                                |
| `observe-agent`      | r-observe-agent                                             |
| `observe-icinga`     | icinga-redis, icinga2, icingadb, icingaweb2                |
| `observe-monitoring` | prometheus, loki, grafana, otel-collector                  |
| `r-observe-proxy`    | r-observe-proxy (Nginx)                                     |

## Setup rápido

```bash
# Diretorio do projeto
cd /opt/results/r-observe

# 1. Copiar e editar variáveis de ambiente
cp .env.observe.example .env.observe
# Editar .env.observe — alterar todos os CHANGE_ME

# 2. Subir stack core
npm run observe:up:core

# 3. Subir stack completa
npm run observe:up:full
```

## Comandos npm

| Script                    | Ação                                            |
|---------------------------|-------------------------------------------------|
| `npm run observe:up`      | Sobe core + AI + monitoring + proxy             |
| `npm run observe:up:core` | Sobe apenas o core (api, worker, db, redis)     |
| `npm run observe:up:full` | Sobe tudo incluindo Icinga e agente             |
| `npm run observe:down`    | Para a stack                                    |
| `npm run observe:build`   | Reconstrói imagens                              |
| `npm run observe:logs`    | Acompanha logs em tempo real                    |
| `npm run observe:ps`      | Lista containers                                |
| `npm run observe:health`  | Verifica saúde dos containers e endpoints       |
| `npm run observe:validate`| Valida configuração do compose                  |
| `npm run observe:smoke`   | Smoke test end-to-end de incidente              |
| `npm run observe:security`| Valida segurança Docker                         |

## Comandos Docker Compose diretos

```bash
cd /opt/results/r-observe
COMPOSE="docker compose -f docker-compose.observe.yml --env-file .env.observe"

# Subir profile específico
$COMPOSE --profile observe-core up -d

# Ver logs de um serviço
$COMPOSE logs -f r-observe-api

# Escalar worker (futuro)
$COMPOSE up -d --scale r-observe-worker=2

# Restart de um serviço
$COMPOSE restart r-observe-api

# Exec no container da API
$COMPOSE exec r-observe-api sh
```

## Variáveis de ambiente

Ver [`.env.observe.example`](../../.env.observe.example) para lista completa.

Variáveis **obrigatórias** (sem default seguro):
- `OBSERVE_DB_PASSWORD`
- `OBSERVE_INTERNAL_TOKEN`
- `OBSERVE_AGENT_TOKEN`
- `ICINGA_API_PASSWORD` (profile observe-icinga)
- `ICINGADB_DB_PASSWORD` (profile observe-icinga)
- `GRAFANA_ADMIN_PASSWORD` (profile observe-monitoring)
