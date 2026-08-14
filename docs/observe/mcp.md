# MCP (Model Context Protocol) do R-Observe

O R-Observe expõe um servidor **MCP** minimal que permite a agentes/assistentes
externos (VS Code, Claude, etc.) consultarem o estado operacional de forma
read-only via **stdio** (JSON-RPC 2.0).

## Ferramentas disponíveis

| Ferramenta             | Descrição                                                      |
|------------------------|----------------------------------------------------------------|
| `r_observe_status`     | Resumo: agentes discovery, ativos monitorados e incidentes abertos |
| `r_observe_incidents`  | Lista incidentes abertos (parâmetro opcional `limit`)           |
| `r_observe_assets`     | Lista ativos monitorados (parâmetro opcional `limit`)           |

## Como executar

O servidor lê as mesmas variáveis `DB_*` usadas pela API (`DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`). Use o usuário de aplicação (`observe_app`).

```bash
DB_HOST=<host> DB_PORT=5432 DB_NAME=observedb \
DB_USER=observe_app DB_PASSWORD=<senha> \
  node r-observe/mcp/server.js
```

Ou via npm:

```bash
npm run mcp:server
```

## Registrando em um cliente MCP

Exemplo (VS Code / Claude) — servidor do tipo `stdio`:

```json
{
  "mcpServers": {
    "r-observe": {
      "command": "node",
      "args": ["/opt/results/ria/r-observe/r-observe/mcp/server.js"],
      "env": {
        "DB_HOST": "10.10.2.30",
        "DB_PORT": "5432",
        "DB_NAME": "observedb",
        "DB_USER": "observe_app",
        "DB_PASSWORD": "<senha>"
      }
    }
  }
}
```

## Por que stdio e não um serviço HTTP

MCP é um protocolo local entre o cliente e o servidor; o modo `stdio` é o padrão
recomendado. Como o servidor é read-only e sem estado, não há necessidade de
rodá-lo como container de longa duração — ele é iniciado sob demanda pelo
cliente MCP.

## Segurança

- Apenas leitura (SELECT).
- Credenciais vêm do ambiente do processo, nunca de hardcode.
- `limit` é limitado (incidentes ≤ 50, ativos ≤ 100) para evitar payloads enormes.
