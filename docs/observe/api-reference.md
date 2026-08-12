# R-Observe — API Reference

**Versão**: 0.1.0
**Base Path**: `/observe/api`

---

## Autenticação

Todas as rotas (exceto health, login) exigem autenticação via cookie de sessão (`observe_session`) ou token JWT interno (`x-internal-token` / `Authorization: Bearer`).

### POST /auth/login
Login com usuário e senha.

```
POST /observe/api/auth/login
Content-Type: application/json

{ "username": "admin", "password": "***" }

→ 200
{
  "ok": true,
  "user": { "name": "admin", "role": "admin" },
  "expires_at": "2026-06-16T03:00:00.000Z",
  "csrf_token": "abc123..."
}
```

### POST /auth/logout
```
POST /observe/api/auth/logout
X-CSRF-Token: <csrf_token>

→ 200 { "ok": true }
```

### GET /auth/me
```
GET /observe/api/auth/me

→ 200
{ "user": { "name": "admin", "role": "admin", "auth_type": "session" } }
```

---

## Health & Status

### GET /health
Público. Status do serviço.

```
GET /observe/api/health
→ 200 { "status": "ok", "service": "r-observe-api", "version": "0.1.0" }
```

### GET /status
Autenticado. Conectividade com DB e Redis.

```
GET /observe/api/status
→ 200
{
  "status": "ok",
  "components": { "api": "ok", "db": "ok", "redis": "ok" }
}
```

### GET /metrics
Requer `x-internal-token` ou `?token=<jwt>`. Métricas Prometheus.

---

## Hosts

### GET /hosts
Lista hosts monitorados.

### GET /hosts/:name
Detalhes de um host específico.

### POST /hosts
Cria/atualiza host manualmente. Requer role `admin`.

```json
{ "name": "web-01", "address": "10.0.0.10", "display_name": "Web Server 01" }
```

---

## Contacts (Usuários)

### GET /contacts
Lista usuários do sistema.

### POST /contacts
Cria usuário. Requer role `admin`.

```json
{ "name": "operator1", "password": "SenhaSegura123!", "active": true, "admin": false }
```

### PATCH /contacts/:name
Atualiza usuário. Requer role `admin`.

---

## Inventory

### POST /inventory/docker
Registra containers Docker descobertos pelo agent.

```json
{
  "agent_id": "local-agent-01",
  "host": "docker-host-01",
  "address": "10.0.0.5",
  "containers": [
    { "name": "nginx", "image": "nginx:alpine", "state": "running", "compose_project": "web" }
  ]
}
```

---

## AI — Análise

### POST /ai/explain
Análise de incidente via IA.

```json
{
  "incident": { "id": "inc-1", "title": "MySQL down", "severity": "critical", "source": "icinga" },
  "context": { "event_output": "Connection refused", "host_address": "10.0.0.10" }
}

→ 200
{
  "summary": "MySQL está inacessível...",
  "cause": "Connection refused — serviço parado ou firewall bloqueando",
  "suggestion": "Verificar status do MySQL com systemctl status mysql",
  "severity_classification": "critical",
  "remediation": { "action": "docker:start", "params": { "container": "mysql" }, "confidence_score": 0.85 }
}
```

### GET /ai/models
Lista modelos disponíveis do provider.

```
GET /observe/api/ai/models?provider=openai

→ 200
{
  "provider": "openai",
  "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", ...],
  "auto": "gpt-4o-mini",
  "source": "api"
}
```

### GET /ai/settings
Configuração atual do AI (sem expor API key).

### POST /ai/settings
Atualiza provider/model/api_key. Requer role `admin`.

```json
{ "provider": "openai", "model": "gpt-4o-mini", "api_key": "sk-..." }
```

---

## AIOps

### POST /ai/rca
Root Cause Analysis.

```json
{
  "incident": { "id": "inc-1", "title": "MySQL down", "severity": "critical", "target_type": "database", "target_name": "mysql-01", "check_type": "tcp" },
  "topology": [
    { "source": "api-service", "target": "mysql-01", "dependency_type": "service_database" }
  ],
  "recent_events": [],
  "similar_incidents": []
}

→ 200
{
  "incident_id": "inc-1",
  "best_hypothesis": {
    "cause": "Falha no banco de dados mysql-01 causou indisponibilidade em 1 serviços dependentes",
    "confidence": 0.85,
    "type": "cascade_failure"
  },
  "impacted_systems": ["api-service"],
  "suggested_actions": [...],
  "root_cause_hypotheses": [...]
}
```

### POST /ai/correlate
Correlação de eventos. `mode`: `dedup` | `cluster` | `patterns` | `full`.

```json
{ "events": [...], "mode": "full" }
```

### POST /ai/similar-incidents
Busca incidentes similares no histórico.

```json
{ "incident": {...}, "min_similarity": 0.3, "max_results": 10 }
```

### GET /ai/playbooks
Busca playbooks de remediação.

```
GET /observe/api/ai/playbooks?check_type=disk&severity=critical

→ 200
{
  "playbooks": [
    {
      "id": "pb_disk_full",
      "title": "Disco cheio — Procedimento de limpeza",
      "relevance": 1.0,
      "risk": "low",
      "steps": [...]
    }
  ]
}
```

### POST /ai/feedback
Registra feedback sobre remediação.

```json
{ "incident_id": "inc-1", "remediation_id": "pb_disk_full", "rating": 1, "comment": "Resolveu o problema" }
```

### GET /ai/feedback/stats
Estatísticas de feedback.

### GET /ai/incidents/stats
Estatísticas do repositório de incidentes.

---

## Discovery (proxy)

As rotas abaixo são proxy para o Discovery Engine (`r-observe-discovery:3010`).

### POST /discovery/api/discovery/scan
Inicia scan de descoberta.

```json
{ "profile": "safe", "trigger": "manual" }
```

### GET /discovery/api/discovery/assets
Lista assets descobertos.

### GET /discovery/api/discovery/topology
Topologia de rede descoberta.

### GET /discovery/api/discovery/runs
Histórico de execuções de discovery.

### GET /discovery/api/discovery/progress
Progresso do scan atual.

---

## Icinga2 (proxy)

### GET /icinga/v1/objects/hosts
Lista hosts no Icinga2.

### GET /icinga/v1/objects/services
Lista serviços no Icinga2.

---

## Códigos de Erro

| Código | Significado |
|---|---|
| 200 | Sucesso |
| 201 | Criado |
| 202 | Aceito (processamento assíncrono) |
| 400 | Requisição inválida |
| 401 | Não autenticado |
| 403 | Não autorizado (role insuficiente) / CSRF inválido |
| 404 | Recurso não encontrado |
| 409 | Conflito (recurso já existe) |
| 429 | Rate limit excedido |
| 500 | Erro interno |
| 502 | Erro no serviço upstream (AI, Discovery) |
| 503 | Serviço indisponível |
| 504 | Timeout |
