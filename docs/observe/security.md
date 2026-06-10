# R-Observe — Segurança

## Princípios

1. **Banco e Redis internos** — sem exposição de porta no host
2. **docker.sock read-only** — agente acessa socket apenas para leitura
3. **no-new-privileges** — todos os containers
4. **Tokens via env** — nunca hardcoded
5. **Segredos fora do git** — `.env.observe` no `.gitignore`
6. **Rate limiting** — endpoints de eventos limitados a 100 req/min
7. **CORS restrito** — configurável por origem
8. **Headers de segurança** — via Helmet (API) e Nginx (proxy)

## Variáveis sensíveis

| Variável                | Uso                                      | Como gerar                     |
|-------------------------|------------------------------------------|---------------------------------|
| `OBSERVE_DB_PASSWORD`   | PostgreSQL                               | `openssl rand -base64 24`      |
| `OBSERVE_REDIS_PASSWORD`| Redis                                    | `openssl rand -base64 24`      |
| `OBSERVE_INTERNAL_TOKEN`| Auth entre serviços internos             | `openssl rand -hex 32`         |
| `OBSERVE_WEBHOOK_SECRET`| Validação de webhooks externos           | `openssl rand -hex 32`         |
| `OBSERVE_AGENT_TOKEN`   | Auth do agente                           | `openssl rand -hex 32`         |
| `ICINGA_API_PASSWORD`   | API Icinga2                              | `openssl rand -base64 20`      |
| `ICINGADB_DB_PASSWORD`  | Banco IcingaDB                           | `openssl rand -base64 24`      |
| `GRAFANA_ADMIN_PASSWORD`| Admin Grafana                            | `openssl rand -base64 20`      |
| `OPENAI_API_KEY`        | API OpenAI (se R_OBSERVE_AI_PROVIDER=openai) | Painel OpenAI              |

## Checklist de produção

- [ ] Todos os `CHANGE_ME` substituídos em `.env.observe`
- [ ] `.env.observe` no `.gitignore`
- [ ] `docker.sock` somente montado no agente (read-only)
- [ ] PostgreSQL sem porta exposta no host
- [ ] Redis sem porta exposta no host
- [ ] Icinga API não acessível publicamente (somente via proxy autenticado)
- [ ] `OBSERVE_INTERNAL_TOKEN` gerado com entropia suficiente (≥32 bytes)
- [ ] `R_OBSERVE_AI_PROVIDER=mock` desabilitado em produção
- [ ] CORS configurado com origens reais (`OBSERVE_CORS_ORIGINS`)
- [ ] Rotação de logs habilitada (configurado no compose via `x-logging`)

## Validação de segurança

```bash
npm run observe:security
# ou
./scripts/observe/check-docker-safety.sh
```

## .gitignore obrigatório

Adicione ao `.gitignore`:

```
.env.observe
.env.observe.*
!.env.observe.example
```

## Rede interna vs pública

| Rede                | Propósito                         | Exposição |
|---------------------|-----------------------------------|-----------|
| `observe-public`    | Proxy, Grafana, IcingaWeb2        | Via proxy |
| `observe-internal`  | API, Worker, AI, DB, Redis        | Interna   |
| `observe-monitoring`| Prometheus, Loki, Icinga, OTel    | Interna   |
| `observe-agent`     | Agente + exporters futuros        | Interna   |

Redes `observe-internal`, `observe-monitoring` e `observe-agent` são declaradas com `internal: true` — sem roteamento para o host ou internet.
