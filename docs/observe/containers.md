# R-Observe — Containers

## r-observe-api

**Imagem:** build local (`r-observe/api/`)  
**Porta interna:** 3000  
**Redes:** observe-internal, observe-monitoring, observe-public

### Endpoints

| Método | Path                          | Descrição                         |
|--------|-------------------------------|-----------------------------------|
| GET    | `/observe/api/health`         | Health check                      |
| GET    | `/observe/api/metrics`        | Métricas Prometheus                |
| GET    | `/observe/api/status`         | Status DB e Redis                 |
| GET    | `/observe/api/hosts`          | Lista hosts                       |
| GET    | `/observe/api/services`       | Lista serviços                    |
| GET    | `/observe/api/incidents`      | Lista incidentes                  |
| GET    | `/observe/api/incidents/:id`  | Detalhe + timeline do incidente   |
| POST   | `/observe/api/events`         | Recebe evento genérico            |
| POST   | `/observe/api/icinga/events`  | Recebe evento do Icinga           |
| POST   | `/observe/api/ai/explain`     | Proxy para IA                     |
| POST   | `/observe/api/remediation/request` | Solicita remediação          |

### Autenticação

Header: `x-internal-token: <OBSERVE_INTERNAL_TOKEN>`  
Todos os endpoints exceto `/health` e `/metrics` requerem o token.

---

## r-observe-worker

**Imagem:** build local (`r-observe/worker/`)  
**Porta interna:** 3000 (health apenas)  
**Redes:** observe-internal

Consome filas Redis:
- `observe:events` — eventos genéricos
- `observe:events:icinga` — eventos do Icinga

Para cada evento do tipo `container.stopped`, `host.down`, `service.critical`, `disk.full`, `check.failed`: cria incidente em `observe_incidents`, registra na timeline, chama IA.

---

## r-observe-ai

**Imagem:** build local (`r-observe/ai/`)  
**Porta interna:** 3000  
**Redes:** observe-internal

### Endpoints

| Método | Path           | Descrição                          |
|--------|----------------|------------------------------------|
| GET    | `/health`      | Health check                       |
| POST   | `/ai/explain`  | Análise de incidente               |
| POST   | `/ai/classify` | Classificação de severidade        |
| POST   | `/ai/summarize`| Resumo de conjunto de eventos      |

### Providers

Configurado via `R_OBSERVE_AI_PROVIDER`:
- `openai` — GPT-4o-mini (padrão)
- `deepseek` — DeepSeek Chat
- `mock` — resposta simulada para dev/test

---

## r-observe-agent

**Imagem:** build local (`r-observe/agent/`)  
**Porta interna:** 3000  
**Redes:** observe-internal, observe-agent

**Acesso ao Docker:** `/var/run/docker.sock:/var/run/docker.sock:ro`

### Checks executados

| Check               | Descrição                                        | Evento gerado           |
|---------------------|--------------------------------------------------|-------------------------|
| Docker daemon       | Ping no daemon                                   | `docker.daemon.down`    |
| Containers parados  | `exited` ou `dead`                               | `container.stopped`     |
| Unhealthy           | Status `unhealthy`                               | `container.unhealthy`   |
| Disco               | `df /` > `DISK_WARN_PERCENT`                     | `disk.high_usage`       |
| Volumes órfãos      | `dangling=true`                                  | `docker.orphan_volumes` |
| HTTP API            | GET `/observe/api/health`                        | `check.failed`          |

**Intervalo:** configurável via `OBSERVE_AGENT_CHECK_INTERVAL_MS` (padrão: 60s)

### Endpoints

| Método | Path          | Descrição                    |
|--------|---------------|------------------------------|
| GET    | `/health`     | Estado do agente             |
| GET    | `/metrics`    | Métricas Prometheus          |
| POST   | `/checks/run` | Dispara check manual         |

---

## r-observe-postgres

**Imagem:** `postgres:16-alpine`  
**Redes:** observe-internal (sem porta exposta)

Bancos criados na inicialização:
- `observedb` — schema R-Observe
- `icingadb` — usado pelo IcingaDB (profile observe-icinga)

---

## r-observe-redis

**Imagem:** `redis:7-alpine`  
**Redes:** observe-internal (sem porta exposta)

Usado como fila de eventos pelo worker.

---

## r-observe-icinga2, r-observe-icingadb, r-observe-icingaweb2, r-observe-icinga-redis

Ver [icinga.md](icinga.md).

---

## r-observe-prometheus, r-observe-loki, r-observe-grafana, r-observe-otel-collector

**Prometheus:** `prom/prometheus:v2.52.0` — scrape dos serviços R-Observe  
**Loki:** `grafana/loki:2.9.8` — agregação de logs  
**Grafana:** `grafana/grafana:10.4.3` — dashboards, datasources provisionados  
**OTel:** `otel/opentelemetry-collector-contrib:0.101.0` — traces gRPC/HTTP

---

## r-observe-proxy

**Imagem:** `nginx:1.25-alpine`  
**Porta exposta:** `OBSERVE_HTTP_PORT` (padrão: 3080)

Rotas:
- `/observe/api/` → r-observe-api:3000
- `/icinga/` → r-observe-icingaweb2:8080
- `/grafana/` → r-observe-grafana:3000
- `/observe/proxy/health` → health do próprio proxy
