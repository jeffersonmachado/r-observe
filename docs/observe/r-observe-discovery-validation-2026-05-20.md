# Relatorio de validacao - R-Observe Discovery Engine

Data: 2026-05-20  
Ambiente validado originalmente em monorepo; apos a separacao, o diretorio operacional do projeto passou a ser `/opt/results/r-observe`. Proxy local: `http://localhost:3080`

## Escopo validado

- Discovery engine: pipeline, API, UI, fila Redis, Docker local discovery, topologia, fingerprints e Prometheus SD.
- Integracao Icinga: API, IcingaWeb2 via proxy, eventos/acoes de remediacao e leitura de hosts/servicos.
- Gestao de contatos: usuarios operacionais do IcingaWeb2 expostos na API e no dashboard IA.
- Visualizacao das acoes da IA: atividade, catalogo, remediacoes, feedback e comparacao Tactical x IA.

## Descobertas tecnicas

- A ultima varredura validada (`5e97921f-f396-4dee-84ad-590e4fecf13b`) concluiu com 1 alvo escaneado, 1 ativo descoberto, 17 containers Docker descobertos e 9 arestas de topologia.
- Ativo descoberto: `10.10.2.30`, fingerprint `SSH`, confianca `0.800`, estado `discovered`.
- Servicos/topologia detectados no ativo: `22`, `53`, `443`, `3000`, `3306`, incluindo dependencias DNS e database.
- Containers descobertos: `r-observe-api`, `r-observe-discovery`, `r-observe-agent`, `r-observe-worker`, `r-observe-ai`, `r-observe-proxy`, `r-observe-grafana`, `r-observe-prometheus`, `r-observe-loki`, `r-observe-icinga2`, `r-observe-icingaweb2`, `r-observe-icingadb`, Redis/Postgres e Portainer.
- Prometheus SD foi escrito em `observe/prometheus/sd/discovery-engine.json`; no cenario atual o arquivo contem `[]` porque nao ha exporter aprovado/monitorado nas portas reconhecidas.
- Icinga Tactical atual: 5 hosts, 8 servicos, com 2 hosts up, 3 down, 2 servicos ok, 3 critical e 3 unknown.
- IA atual: 6 incidentes analisados, 1 remediacao auto-executada, 1 pendente de aprovacao, 2 falhas acumuladas e 2 feedbacks positivos.
- Contatos atuais: `admin`, ativo, administrador.

## Ajustes realizados

- Corrigido o calculo de `comparison/tactical-ai` para usar a atividade persistida da API, nao um endpoint inexistente no servico de IA.
- Adicionados endpoints `/observe/api/contacts` para listar/criar/atualizar contatos operacionais do IcingaWeb2.
- Adicionada aba `Contatos` no dashboard IA.
- Corrigido discovery para marcar execucoes futuras como `failed` quando houver erro, evitando runs presas em `running`.
- Encerradas 9 runs antigas presas em `running` como `failed`/stale durante a validacao.
- Corrigidas permissoes do Docker local discovery: `group_add` para GID `137` e usuario efetivo do discovery `1000:1000`.
- Corrigida permissao de escrita do Prometheus SD no bind mount `observe/prometheus/sd`.
- Habilitado `accept_config` e `accept_commands` no Icinga2 API bootstrap.
- Corrigido proxy do Icinga para respeitar `$scheme` em ambiente HTTP local.
- Corrigido o acesso das telas IcingaDB: senha do role PostgreSQL `icingadb` alinhada ao `.env.observe`, schema do banco reconstruido para versao 5 usando o SQL oficial da imagem `icinga/icingadb:1.5.1` e servico `r-observe-icingadb` reiniciado.
- Corrigido redirect do proxy para paths Icinga sem prefixo (`/dashboard`, `/icingadb`, etc.) usando redirect relativo, preservando porta local.
- Removido `Content-Security-Policy: upgrade-insecure-requests` do proxy Icinga local, pois forçava HTTPS em `localhost:3080` e quebrava a navegacao pos-login.
- Corrigido teste/tela de problemas do IcingaDB para usar filtro valido `host.state.is_problem=y` em vez de `problems=1`.
- Endurecido o teste `tests/e2e/icingaweb-screenshot.spec.js` para falhar quando houver login indevido, 5xx, exception, SQLSTATE ou pagina de erro, em vez de apenas capturar prints.
- Corrigido fallback de ordenacao dos modelos OpenAI quando a API externa nao responde.
- Corrigido titulo da UI de configuracao para alinhar com o teste E2E.
- Melhorada mensagem do script `scripts/observe/token.sh` quando o problema e permissao no Docker daemon.

## Validacoes executadas

- `npm --prefix ./r-observe/discovery test`: 10/10 passou.
- `node --check r-observe/api/src/index.js`: passou.
- `node --check r-observe/discovery/src/engine/discovery-engine.js`: passou.
- `docker compose -f docker-compose.observe.yml --env-file .env.observe config --quiet`: passou.
- `OBSERVE_TOKEN=CHANGE_ME npx playwright test tests/e2e/observe-stack.spec.js --project=chromium`: 27/27 passou.
- `OBSERVE_TOKEN=CHANGE_ME npx playwright test tests/e2e/ai-dashboard.spec.js --project=chromium`: passou.
- `ICINGAWEB_ADMIN_USER=admin ICINGAWEB_ADMIN_PASS=CHANGE_ME npx playwright test tests/e2e/icingaweb-screenshot.spec.js --project=chromium`: passou.
- `ICINGAWEB_ADMIN_PASS=CHANGE_ME npx playwright test tests/e2e/icingaweb-login.spec.js tests/e2e/icingaweb-screenshot.spec.js --project=chromium`: 2/2 passou apos correcao das telas Icinga.
- Validacao direta do IcingaDB no PostgreSQL: `icingadb_schema.version = 5`, 5 hosts e 8 servicos repopulados pelo sync do IcingaDB.
- Logs recentes do `r-observe-icingadb`: conexao com PostgreSQL/Redis, sync inicial de config/state concluido e instancia ativa em HA.
- Teste manual de discovery via API: `POST /observe/discovery/api/discovery/scan`, validado em `/progress` e `/data/summary`.
- Teste manual de Docker discovery dentro do container: listou 17 containers via `/var/run/docker.sock`.
- Teste manual de acao Icinga: `icinga.rescheduleCheck('observe-api')` retornou HTTP 200.

## Evidencias visuais

- `test-results/discovery-overview.png`
- `test-results/discovery-assets.png`
- `test-results/ai-overview.png`
- `test-results/ai-contacts.png`
- `test-results/icinga-dashboard.png`
- `test-results/icinga-hosts.png`
- `test-results/icinga-services.png`
- `test-results/icinga-problems.png`

## Observacoes

- A API do Icinga aceita comandos apos o ajuste (`reschedule-check` validado com HTTP 200). A criacao dinamica direta de objetos via `/v1/objects/hosts/<name>` ainda retorna 404 no Icinga2 2.15.3; por isso o CRUD manual de host continua persistindo no banco e tratando sincronizacao Icinga como nao-fatal. Para cadastro dinamico real de objetos Icinga, o caminho tecnicamente correto e evoluir para a API de config packages/stages ou gerar configuracao declarativa versionada.
- O token atual em `.env.observe` e `CHANGE_ME`; funcional para validacao local, mas inseguro para producao.
