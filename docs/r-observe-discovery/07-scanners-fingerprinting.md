# Scanners e fingerprinting

## Active discovery (baseline atual)

- TCP connect
- reverse DNS
- HTTP/HTTPS fingerprint basico (headers)
- deteccao de servico por combinacao de portas
- discovery local Docker (container inventory)

## Passive discovery (baseline atual)

- endpoint de ingestao de eventos passive normalizados
- tipos previstos: ARP, DHCP, DNS, mDNS, SSDP, SIP REGISTER, HTTP Host, TLS SNI, NetBIOS

## Fingerprint sources suportadas no baseline

- MAC/OUI (heuristico)
- portas abertas combinadas
- HTTP server header
- DNS reverso
- metadados recebidos (SNMP/TLS quando fornecidos por sensores)

## Vendors/servicos com heuristica inicial

- MikroTik
- Intelbras
- Hikvision
- Grandstream
- ControlID
- PostgreSQL
- MariaDB
- Prometheus
- Grafana
- PowerDNS

## Proximo nivel

- banners reais por protocolo
- favicon hash
- parser TLS certificado completo
- parser ONVIF e RTSP detalhado
- parser SNMP sysDescr real
