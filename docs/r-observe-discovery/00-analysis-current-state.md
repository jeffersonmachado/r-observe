# Analise obrigatoria do ambiente atual

## O que ja existe no infra

### Core R-Observe existente
- API Node com DB PostgreSQL e Redis: filas de eventos, incidents, remediations, endpoints de health/metrics.
- Worker Node com processamento continuo via BLPOP em Redis (`observe:events`, `observe:events:icinga`, `observe:remediation:execute`, `observe:scan:results`).
- Agent local com inventario Docker e checks HTTP/TCP/disco.
- Integracao Icinga2 via API REST (registro de host, remocao, reschedule, listagem).
- Prometheus com `http_sd` e `file_sd` ja ativos.
- OTel collector, Loki, Grafana e dashboards/provisioning.

### Discovery anterior existente (nao enterprise)
- Script shell [scripts/observe/discover-hosts.sh](../../scripts/observe/discover-hosts.sh) com varredura pontual.
- Capacidades atuais: ping/nmap, reverse DNS, portas conhecidas, registros em Icinga, geracao `file_sd`.
- Limitacoes: sem historico modelado de assets, sem drift enterprise, sem topologia/dependency graph, sem multi-tenant.

### Inventario atual existente
- Tabelas atuais: `observe_hosts`, `observe_services`.
- Adequadas para monitoramento base e incidentes, mas insuficientes para discovery autonomo enterprise.

## Reuso adotado

- Redis event bus e padrao de filas existentes foram reaproveitados.
- Integracao Icinga reaproveitada via modelo de API ja consolidado.
- Integracao Prometheus SD reaproveitada e estendida.
- Telemetria OTel/Prometheus reaproveitada no novo servico.
- Compose, redes e proxy existentes reaproveitados.

## O que foi substituido/estendido

- Discovery por script manual foi estendido por engine continuo em servico dedicado.
- Modelo host/service foi mantido para compatibilidade, mas discovery passa a usar schema proprio de assets.
- API principal ganhou camada de compatibilidade para proxyar `/observe/api/discovery/*`.

## Gaps identificados e cobertos neste ciclo

- Falta de schema enterprise para discovery: coberto em migration 004.
- Falta de servico dedicado de discovery: coberto por `r-observe-discovery`.
- Falta de endpoints REST discovery: cobertos em `/api/discovery/*`.
- Falta de eventos discovery padronizados: cobertos no bus Redis.
- Falta de drift detection e historico de mudancas: coberto em `observe_asset_changes`.
- Falta de topologia operacional: coberto em `observe_topology_edges`.
- Falta de interface discovery: coberto por UI React em `/observe/discovery`.

## Gaps futuros ainda planejados

- Fingerprinting profundo com parsers SNMP/RTSP/ONVIF reais (hoje baseline heuristico).
- Passive engine com Zeek/Suricata/eBPF integrado.
- Dependency graph em grafo dedicado (Neo4j) e replay temporal completo.
- Edge agent dedicado (`r-observe-edge-agent`) distribuido com sincronizacao WAN otimizada.
