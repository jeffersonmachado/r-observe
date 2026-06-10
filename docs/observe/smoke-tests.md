# R-Observe — Smoke Tests

## Pré-requisitos

- Stack core + AI rodando:
  ```bash
  npm run observe:up
  ```
- `.env.observe` configurado (especialmente `OBSERVE_INTERNAL_TOKEN`)
- `curl` e `docker` disponíveis no host

## Executar

```bash
npm run observe:smoke
# ou
./scripts/observe/smoke-observe-stack.sh
```

## O que o smoke test valida

O script executa **10 steps sequenciais**:

| Step | Descrição                               | Verifica                                  |
|------|-----------------------------------------|-------------------------------------------|
| 1    | Health da API                           | HTTP 200 em `/observe/api/health`         |
| 2    | Status dos serviços internos            | Redis e PostgreSQL respondendo            |
| 3    | Envio de evento de teste                | POST `/observe/api/events` retorna 202    |
| 4    | Worker processou o evento               | Incidente criado em `observe_incidents`   |
| 5    | Incidente listado na API                | GET `/observe/api/incidents` retorna ≥1   |
| 6    | Detalhe do incidente com timeline       | GET `/observe/api/incidents/:id`          |
| 7    | Requisição de análise IA                | POST `/observe/api/ai/explain`            |
| 8    | IA retornou campos esperados            | `summary`, `cause`, `suggestion` presentes|
| 9    | Requisição de remediação                | POST `/observe/api/remediation/request`   |
| 10   | Incidente pode ser encerrado            | Evento de resolução aceito                |

## Resultado esperado

```
[SMOKE] R-Observe stack smoke test
[PASS] Step 1: API health
[PASS] Step 2: Services status
[PASS] Step 3: Send test event
[PASS] Step 4: Worker processed event
[PASS] Step 5: Incidents listed
[PASS] Step 6: Incident detail with timeline
[PASS] Step 7: AI explain request
[PASS] Step 8: AI fields present
[PASS] Step 9: Remediation request
[PASS] Step 10: Incident resolution

[SMOKE] All 10 steps passed ✓
```

## Falha em step

Se um step falhar, o script exibe:
```
[FAIL] Step X: <mensagem> — Got: <resposta HTTP>
[SMOKE] Smoke test FAILED at step X
```

Consulte [troubleshooting.md](troubleshooting.md) para diagnóstico.

## Smoke test manual (passo a passo)

### Enviar evento

```bash
TOKEN=$(grep OBSERVE_INTERNAL_TOKEN .env.observe | cut -d= -f2)
curl -sf -X POST http://localhost:3080/observe/api/events \
  -H "Content-Type: application/json" \
  -H "x-internal-token: $TOKEN" \
  -d '{"type":"container.stopped","host":"test-host","container":"test-container","severity":"warning"}'
```

### Verificar incidente criado

```bash
curl -sf http://localhost:3080/observe/api/incidents \
  -H "x-internal-token: $TOKEN" | jq '.[0]'
```

### Verificar fila Redis

```bash
docker exec r-observe-redis redis-cli LLEN observe:events
```
