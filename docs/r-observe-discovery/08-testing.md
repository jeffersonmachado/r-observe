# Testes

## Cobertura deste ciclo

- Unit
  - fingerprint
  - topology
- Integration
  - Prometheus SD transform
- Simulation
  - politica `safe` nao agressiva

## Execucao

No modulo discovery:

```bash
cd /opt/results/r-observe/r-observe/discovery
npm test
```

## Validacao de integracao da stack

```bash
cd /opt/results/r-observe
npm run observe:validate
npm run observe:smoke
npm run observe:smoke:icinga
```

## Validacao de empacotamento de release

```bash
cd /opt/results/r-observe
npm run zip
npm run zip:release
```

Regras obrigatorias aplicadas no validador de ZIP:

- quantidade minima de arquivos (`>= 500`)
- presenca dos arquivos criticos do Discovery Engine
- presenca de `docker-compose.observe.yml` e `scripts/observe/validate-compose.sh`
- manifesto sem duplicidade e consistente com o conteudo real do ZIP
- bloqueio de arquivos proibidos (`node_modules`, `.git`, `.env*`, dumps, backups, caches, traces, screenshots e temporarios)
- varredura para detectar possiveis secrets
