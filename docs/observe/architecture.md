# R-Observe AI Ops — Arquitetura

## Visão Geral

O R-Observe é uma plataforma de AIOps containerizada para monitoramento inteligente de infraestrutura, integrada ao ecossistema Icinga/Prometheus com análise por IA.

## Diagrama da Stack

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          observe-public (bridge)                          │
│   ┌────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐ │
│   │r-observe-proxy │ │r-observe-icingaweb2│ │   r-observe-grafana    │ │
│   │    Nginx:80    │ │      :8080        │ │        :3000            │ │
│   └──────┬───────┘   └────────┬────────┘   └────────────┬─────────────┘ │
└──────────┼────────────────────┼────────────────────────  ┼──────────────┘
           │                    │                           │
┌──────────▼────────────────────▼───────────────────────── ▼──────────────┐
│                         observe-internal (internal)                       │
│   ┌───────────────┐   ┌───────────────┐   ┌─────────────────────────┐   │
│   │ r-observe-api │   │r-observe-worker│  │      r-observe-ai        │   │
│   │    :3000      │   │   :3000        │  │        :3000             │   │
│   └──┬──┬──┬──────┘   └──────┬────────┘   └──────────────────────────┘  │
│      │  │  │                  │                                           │
│  ┌───┘  │  └────┐         ┌──┘                                           │
│  │      │       │         │                                               │
│  ▼      ▼       ▼         ▼                                               │
│ PG   Redis   Icinga2   Redis (shared)                                     │
└────────────────────────────────────────────────────────────────────────── ┘
           │                    │
┌──────────▼────────────────────▼─────────────────────────────────────────┐
│                       observe-monitoring (internal)                       │
│  ┌────────────┐  ┌──────────┐  ┌────────────┐  ┌─────────────────────┐  │
│  │ prometheus │  │   loki   │  │  icinga2   │  │  otel-collector     │  │
│  │   :9090    │  │  :3100   │  │   :5665    │  │  :4317/:4318        │  │
│  └────────────┘  └──────────┘  └────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
           │
┌──────────▼────────────────────────────────────────────────────────────┐
│                         observe-agent (internal)                        │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ r-observe-agent  (acesso read-only ao docker.sock do host)      │  │
│   └─────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

## Portas Expostas

| Serviço         | Porta Host   | Porta Container | Rede             |
|-----------------|--------------|-----------------|------------------|
| r-observe-proxy | 3080         | 80              | observe-public   |
| (somente proxy; todos os demais serviços internos não expõem portas) |

## Fluxo de Evento

```
Host/Container    →  r-observe-agent  →  r-observe-api  →  Redis Queue
                                                              ↓
                                                        r-observe-worker
                                                              ↓
                                                    observe_incidents (PG)
                                                              ↓
                                                        r-observe-ai
                                                              ↓
                                                    ai_summary/cause/suggest
```

## Fluxo de Incidente Icinga

```
Icinga2  →  IcingaDB (Redis buffer)  →  icingadb  →  PostgreSQL (icingadb DB)
   ↓
Icinga API  →  r-observe-api (/icinga/events)  →  Redis Queue
                     ↓
               r-observe-worker  →  observe_incidents
```

## Componentes

### Core (profile: observe-core)
- **r-observe-postgres**: PostgreSQL 16 — banco principal e IcingaDB
- **r-observe-redis**: Redis 7 — fila de eventos
- **r-observe-api**: API REST — gateway de eventos, consultas e IA
- **r-observe-worker**: Worker assíncrono — correlação, incidentes, IA

### IA (profile: observe-ai)
- **r-observe-ai**: Serviço de IA — OpenAI/DeepSeek/mock

### Agent (profile: observe-agent)
- **r-observe-agent**: Agente local — checks Docker, disco, HTTP

### Icinga (profile: observe-icinga)
- **r-observe-icinga-redis**: Redis dedicado para IcingaDB buffer
- **r-observe-icinga2**: Motor de monitoramento
- **r-observe-icingadb**: Sincronizacao Icinga2→PostgreSQL
- **r-observe-icingaweb2**: Interface web

### Monitoring (profile: observe-monitoring)
- **r-observe-prometheus**: Coleta de metricas
- **r-observe-loki**: Agregacao de logs
- **r-observe-grafana**: Dashboards
- **r-observe-otel-collector**: Traces e metricas OpenTelemetry

### Proxy (profile: r-observe-proxy)
- **r-observe-proxy**: Nginx — roteamento publico
