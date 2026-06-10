# r-observe-discovery

Engine enterprise de discovery continuo para R-Observe.

## Escopo implementado neste ciclo

- Servico dedicado `r-observe-discovery`
- APIs discovery completas
- Inventario enterprise e drift baseline
- Fingerprinting heuristico inicial
- Topologia operacional inicial
- Integracao com Redis event bus
- Integracao com Prometheus HTTP SD/File SD
- Integracao com Icinga (estado aprovado/monitorado)
- UI React inicial em `/observe/discovery`
- Testes unitarios/integracao/simulacao basicos

## Operacao

- Subir stack: `npm run observe:up:full`
- Executar discovery engine: `npm run observe:discover:engine:scan`
- Consultar runs: `npm run observe:discover:engine:runs`
- Consultar assets: `npm run observe:discover:engine:assets`

## Documentos

- `00-analysis-current-state.md`
- `01-architecture.md`
- `02-api.md`
- `03-events.md`
- `04-security.md`
- `05-database.md`
- `06-edge-agents.md`
- `07-scanners-fingerprinting.md`
- `08-testing.md`

## Maturidade atual

Status: pronto para producao no escopo atual do projeto, com gates verdes no pipeline de release.

Capacidades ja entregues:

- Gate obrigatorio do Discovery Engine (test, lint, smoke, audit, integration)
- Integracao real com Redis, Postgres e Prometheus SD
- Fingerprinting e topologia com cobertura de fornecedores e servicos prioritarios
- Guardrails de seguranca e controles de profile safe por padrao
- Validacao de empacotamento e auditoria de release com testes destrutivos

## O que ainda falta para "enterprise completo"

Itens abaixo nao bloqueiam o escopo atual, mas sao recomendados para maturidade enterprise total:

- Descoberta distribuida multi-site com agentes remotos resilientes
- Reconciliacao avancada de identidade de ativos (dedupe semantico e correlacao)
- RBAC granular e trilha de auditoria imutavel por tenant/ambiente
- Cobertura ampliada de protocolos e fontes cloud em larga escala
- Politicas formais de HA/DR, SLO/SLA e testes de capacidade continuos
- Framework de compliance ampliado (ex.: controles NIST/CIS/SOX aplicaveis)

## Criterio pratico de aceitacao

Para o estado atual, considerar o Discovery Engine aprovado quando:

- `npm run discovery:gate` retorna sucesso
- `npm run release:gate` retorna sucesso
- artefatos de release passam em `release:audit` sem falhas
