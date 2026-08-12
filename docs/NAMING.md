# Naming Convention — Infra Results

## Prefixo `r-observe-*`

Todos os containers do stack de observabilidade usam o prefixo `r-observe-`:

| Container | Serviço | Porta interna |
|---|---|---|
| `r-observe-proxy` | Nginx reverse proxy | 80→3080 (host) |
| `r-observe-api` | API principal | 3000 |
| `r-observe-worker` | Worker (jobs, remediação) | — |
| `r-observe-ai` | IA / análise | 3000 |
| `r-observe-discovery` | Discovery Engine | 3010 |
| `r-observe-agent` | Agente de coleta | 3000 |
| `r-observe-postgres` | PostgreSQL | 5432 |
| `r-observe-redis` | Redis (cache/filas) | 6379 |
| `r-observe-icinga2` | Icinga 2 Core | 5665 |
| `r-observe-icingadb` | Icinga DB | — |
| `r-observe-icinga-redis` | Redis (IcingaDB) | 6379 |
| `r-observe-icingaweb2` | Icinga Web 2 | 8080 |
| `r-observe-grafana` | Grafana | 3000 |
| `r-observe-prometheus` | Prometheus | 9090 |
| `r-observe-loki` | Loki (logs) | 3100 |
| `r-observe-alloy` | Grafana Alloy (coleta logs → Loki) | 12345 |
| `r-observe-otel-collector` | OpenTelemetry Collector | 4317, 4318 |

## Por que `r-observe-` e não `observe-`?

1. **Consistência**: todos os containers do projeto `infra` seguem o mesmo padrão
2. **Namespacing**: evita colisão com containers de outros projetos na mesma máquina
3. **DNS interno**: containers na mesma rede Docker resolvem por `container_name`
   - Ex: `r-observe-api` resolve para o IP do container da API
   - O healthcheck do Icinga referencia `r-observe-proxy` pelo nome

## Prefixo `results-mail-*`

Containers do stack de email:

| Container | Serviço |
|---|---|
| `results-mail-postfix-mx1` | SMTP MX1 |
| `results-mail-postfix-mx2` | SMTP MX2 |
| `results-mail-dovecot` | IMAP/POP3 |
| `results-mail-rspamd` | Anti-spam |
| `results-mail-clamav` | Antivírus |
| `results-mail-redis` | Redis (rspamd) |
| `results-mail-certbot` | Certbot (SSL) |
| `results-mail-ldap` | LDAP |

## Prefixo `dns-*`

Containers do stack de DNS:

| Container | Serviço |
|---|---|
| `dns-dnsdist` | DNS Load Balancer |
| `pdns-auth` | PowerDNS Authoritative |
| `pdns-recursor` | PowerDNS Recursor |

## Prefixo `srvmysql*` e `proxysql*`

Containers do stack de banco de dados:

| Container | Serviço |
|---|---|
| `srvmysql0` | Galera node 0 (10.10.2.79) |
| `srvmysql1` | Galera node 1 (10.10.2.89) |
| `srvmysql2` | Galera node 2 (10.10.2.49) |
| `proxysql-galera` | ProxySQL — load balancer SQL (10.10.2.99) |

## Redes Docker

Redes usam `observe-*` (não `r-observe-*`) porque são compartilhadas entre containers:

| Rede | Propósito | Interna? |
|---|---|---|
| `observe-internal` | API, worker, AI, banco, Redis | sim |
| `observe-monitoring` | Prometheus, Loki, Grafana, OTel, Icinga | sim |
| `observe-egress` | Acesso externo (IA, proxy) | não |
| `observe-public` | Proxy, Grafana, IcingaWeb2 | não |
| `observe-agent` | Agente + exporters | — |

## Regras

1. **Container**: `r-observe-<serviço>` ou prefixo do stack (`results-mail-*`, `dns-*`)
2. **Rede**: `observe-<propósito>`
3. **Volume**: `r-observe-<serviço>-data`
4. **Profile Compose**: igual ao nome do container
5. **Nunca**: misturar `observe-*` e `r-observe-*` para containers — ou é um, ou é outro
