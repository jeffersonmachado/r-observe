# Preparacao para Edge Agents

## Estado atual

- Arquitetura multi-tenant/site/edge pronta no schema.
- Engine aceita `edge_id` e `tenant_id` em runs.
- Passive endpoint pronto para ingestao de sensores externos.

## Evolucao planejada

Criar `r-observe-edge-agent` com:
- discovery local
- queue local
- agregacao/filtro local
- envio de findings/eventos para central
- cache offline/retry
- sync de politicas por tenant/site/edge

## Integracao futura

- Zeek/Suricata/eBPF como produtores passive.
- federacao de edges para core discovery.
