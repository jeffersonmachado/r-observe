# R-Observe — AIOps

## Visão Geral

O serviço `r-observe-ai` fornece capacidades de inteligência artificial para análise de incidentes de infraestrutura.

## Providers suportados

| Provider    | Variável                     | Modelo padrão    |
|-------------|------------------------------|------------------|
| `openai`    | `OPENAI_API_KEY`             | `gpt-4o-mini`    |
| `deepseek`  | `DEEPSEEK_API_KEY`           | `deepseek-chat`  |
| `mock`      | (sem API key necessária)     | `mock-v1`        |

Configure com:
```bash
R_OBSERVE_AI_PROVIDER=openai
R_OBSERVE_AI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

## Fluxo de análise automática

1. Worker detecta evento do tipo incidente
2. Cria registro em `observe_incidents`
3. Chama `POST /ai/explain` no serviço r-observe-ai
4. Resultado populado nos campos:
   - `ai_summary` — resumo executivo
   - `ai_cause` — causa provável
   - `ai_suggestion` — ação sugerida
5. Evento `ai_analysis_complete` adicionado à timeline

## Endpoints da API AI

### POST /ai/explain

Analisa um incidente e retorna:

```json
{
  "summary": "Container test-container parou inesperadamente...",
  "cause": "Possível OOM killer ou erro de aplicação",
  "suggestion": "Verificar logs com 'docker logs test-container'...",
  "severity_classification": "warning",
  "recurrence": false,
  "provider": "openai",
  "model": "gpt-4o-mini"
}
```

**Body:**
```json
{
  "incident": {
    "id": "uuid",
    "title": "container.stopped — my-app",
    "severity": "warning",
    "source": "r-observe-agent"
  },
  "context": { "extra": "info" }
}
```

### POST /ai/classify

Classifica severidade de um evento.

### POST /ai/summarize

Gera resumo de múltiplos eventos (até 10).

## Chamar IA via API principal

```bash
curl -sf -X POST http://localhost:3000/observe/api/ai/explain \
  -H 'Content-Type: application/json' \
  -H 'x-internal-token: <OBSERVE_INTERNAL_TOKEN>' \
  -d '{
    "incident": {
      "id": "my-incident-id",
      "title": "host.down — servidor-01",
      "severity": "critical",
      "source": "icinga2"
    }
  }'
```

## Modo mock (desenvolvimento)

Para desenvolvimento sem API key:
```bash
R_OBSERVE_AI_PROVIDER=mock
```

O provider mock retorna respostas simuladas imediatamente, útil para smoke tests.

## Copiloto operacional (futuro)

Planejado para v0.2: endpoint `POST /ai/copilot` que mantém contexto de conversa e permite interação interativa via API.
