# Versões da stack (`/observe/versions`)

Página que exibe as versões de todos os componentes do stack R-Observe, acessível
pelo item **ⓘ Versões** nas topbars da UI (Home, Configuração, IA Dashboard e
detalhe de ativo).

## Como funciona

- A página `GET /observe/versions` (servida pela `r-observe-api`) consome o
  endpoint `GET /observe/api/system/versions` (requer sessão).
- O endpoint retorna o conteúdo de `r-observe/api/src/stack-versions.json`.
- Esse JSON é **gerado**, não editado à mão, pelo script
  `scripts/observe/update-stack-versions.js`.

## Fontes de verdade

O script extrai as versões de três lugares, sem duplicação manual:

| Fonte | Exemplo | Usado para |
|---|---|---|
| `docker-compose.observe.yml` (`image:`) | `prom/prometheus:v3.13.1-distroless@sha256:...` | Prometheus, OTel Collector, redis-exporter, Redis, Nginx |
| Dockerfile `ARG <...>_VERSION=` | `ARG LOKI_VERSION=3.7.2` | Loki, Alloy, postgres-exporter, snmp-exporter, Icinga DB |
| Dockerfile `FROM <imagem>:<tag>` (último estágio) | `FROM grafana/grafana:13.1.2@sha256:...` | Grafana, PostgreSQL, Icinga 2, Icinga Web 2 |
| `package.json` (`version`) | `r-observe/api/package.json` → `0.1.0` | api, worker, ai, agent, discovery |

## Quando atualizar

**Sempre que alterar a versão de uma imagem** no `docker-compose.observe.yml` ou
em um Dockerfile (tag de `FROM` ou `ARG *_VERSION`), execute:

```bash
npm run observe:update-versions
```

e commite o `r-observe/api/src/stack-versions.json` atualizado.

O script é idempotente e apenas regrava o JSON a partir das fontes atuais,
imprimindo a lista gerada para conferência.

## Adicionar/remover um componente

Edite o catálogo `CATALOG` dentro de `scripts/observe/update-stack-versions.js`.
Cada entrada mapeia um nome de exibição para uma fonte:

```js
{ group: 'monitoring', name: 'Prometheus', source: { type: 'compose', service: 'r-observe-prometheus' } },
{ group: 'monitoring', name: 'Loki', source: { type: 'dockerfile-arg', path: 'observe/loki/Dockerfile', arg: 'LOKI_VERSION' } },
{ group: 'core', name: 'r-observe-api', source: { type: 'package', path: 'r-observe/api/package.json' } },
```

Tipos de `source` suportados:

- `package` — lê `version` de um `package.json`.
- `compose` — lê a tag do campo `image:` do serviço indicado.
- `dockerfile-arg` — lê `ARG <arg>=<valor>` do Dockerfile.
- `dockerfile-from` — lê a tag do último `FROM` (estágio de runtime).

Depois de editar o catálogo, rode o script novamente.

## Rotas

| Rota | Método | Auth | Descrição |
|---|---|---|---|
| `/observe/versions` | GET | sessão web | Página HTML |
| `/observe/api/system/versions` | GET | sessão/JWT | JSON com `stack`, `version`, `generated_at` e `groups` |

O proxy nginx roteia `/observe/versions` para a API (`observe/nginx/conf.d/observe.conf`).
