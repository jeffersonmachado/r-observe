# R-Observe Discovery Engine Enterprise

Data: 2026-05-20

## Arquitetura

Discovery Engine
-> Active Scan (TCP/HTTP/TLS/SNMP)
-> Passive Ingestion (syslog, mDNS, SSDP, SNMP trap)
-> Fingerprint Engine
-> Topology Correlation
-> Operational Inventory (PostgreSQL)
-> Graph Layer (Neo4j opcional)
-> Monitoring Onboarding (Prometheus SD + Icinga sync)

## Pipeline Operacional

L1 Connectivity:
- ping/icmp implícito via conectividade e tcp connect
- ARP table/arp-scan (quando disponível)

L2 Port Scan:
- scan de portas por perfil safe/balanced/aggressive

L3 Service Detection:
- banners TCP (SSH/SMTP)
- HTTP headers/title
- TLS cert subject/issuer/hash
- SNMP sysDescr/sysName/sysUptime

L4 Fingerprint:
- correlação de portas + banners + SNMP + OUI + sinais passivos
- score de confiança

L5 Topology:
- host_service
- service_dependency
- service_exporter
- container_service

L6 Onboarding:
- Prometheus HTTP SD
- Icinga config package/stage + fallback PUT host + reconcile

## Escopos de Target

Suportados:
- IP único
- CIDR
- Range
- Hostname/FQDN (resolução DNS A)

Controles:
- maxHosts
- maxScanTargets
- chunking
- rate limiting
- allowlist/denylist

## Passive Discovery

Entradas reais:
- API passive events
- UDP syslog listener (default 5514)
- UDP SNMP trap listener (default 9162)
- UDP mDNS listener (5353 multicast)
- UDP SSDP listener (1900 multicast)

Saídas:
- finding passive_signal
- upsert de asset com lifecycle discovered
- evento Redis observe.discovery.asset_found

## Fingerprints suportados (evidência)

Vendors:
- Cisco
- MikroTik
- Ubiquiti
- HP
- Fortinet
- Grandstream
- Intelbras
- Hikvision
- Dahua
- Yealink

Classes:
- web
- database
- observability
- switch
- router
- ap
- voice
- firewall
- dns
- iot

## Topology Model

Relacionamentos:
- connected_to (host_service)
- depends_on (service_dependency)
- managed_by (service_exporter)
- hosted_on (container_service)

## Neo4j (opcional)

Env:
- NEO4J_URI
- NEO4J_USER
- NEO4J_PASSWORD

APIs:
- GET /api/discovery/graph/shortest-path
- GET /api/discovery/graph/blast-radius

## Icinga Enterprise Sync

Fluxo:
- discovered -> approved/monitored -> sync

Ações:
- stage config package (best effort endpoints)
- deploy stage (best effort endpoints)
- fallback PUT /objects/hosts
- reconcile de hosts gerenciados
- limpeza de órfãos (DELETE hosts stale)

## Troubleshooting Rápido

1. Sem assets no smoke:
- validar allowlist/denylist e target expansion
- validar policy default para tenant/site/edge

2. Passive listeners não sobem:
- ajustar portas via env DISCOVERY_*_PORT
- validar bind de portas no container

3. Neo4j 503:
- conferir NEO4J_URI e credenciais

4. Icinga sync warning:
- conferir ICINGA_API_URL/USER/PASSWORD
- verificar permissões de API para config packages

## Onboarding

1. Subir stack core:
- npm run observe:up:core

2. Executar gate:
- npm run discovery:gate

3. Iniciar scan:
- POST /api/discovery/scan

4. Aprovar ativos para monitoramento:
- PATCH /api/discovery/assets/:id lifecycle_state=approved|monitored

5. Validar SD e Icinga:
- GET /api/discovery/prometheus/http-sd
- verificar eventos observe.discovery.icinga_sync_completed
