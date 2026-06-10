# R-Observe — Troubleshooting

> **Nota**: Para problemas com o servidor de email (Postfix, Dovecot, Roundcube),
> consulte [mail-server-fix-2026-06-09.md](./mail-server-fix-2026-06-09.md).

## Diagnóstico rápido

```bash
cd /opt/results/r-observe

# Status de todos os containers
npm run observe:ps

# Health check completo
npm run observe:health

# Logs em tempo real
npm run observe:logs

# Log de um serviço específico
docker compose -f docker-compose.observe.yml --env-file .env.observe logs -f r-observe-api
```

---

## Problemas comuns

### Container não sobe / restart loop

**Sintoma:** `docker ps` mostra `Restarting`

```bash
docker logs r-observe-api --tail 50
docker inspect r-observe-api --format '{{.State.Health}}'
```

**Causas comuns:**
- Variável de ambiente não configurada → verificar `.env.observe`
- PostgreSQL ainda não está pronto → aguardar healthcheck do postgres
- Porta já em uso no host → verificar `OBSERVE_HTTP_PORT`

---

### API retorna 401 Unauthorized

**Causa:** Token ausente ou incorreto no header.

```bash
# Verificar token configurado
grep OBSERVE_INTERNAL_TOKEN .env.observe
```

Incluir header na chamada:
```
x-internal-token: <valor do OBSERVE_INTERNAL_TOKEN>
```

---

### Eventos não viram incidentes

**Verificar fila Redis:**
```bash
docker exec r-observe-redis redis-cli LLEN observe:events
docker exec r-observe-redis redis-cli LRANGE observe:events 0 5
```

**Verificar logs do worker:**
```bash
docker logs r-observe-worker --tail 100 | grep -E "ERROR|event|incident"
```

---

### IA não analisa incidentes

**Sintoma:** Incidentes sem `ai_summary`

**Verificar provider:**
```bash
grep R_OBSERVE_AI .env.observe
docker logs r-observe-ai --tail 50
```

**Usar mock temporariamente:**
```bash
# Em .env.observe:
R_OBSERVE_AI_PROVIDER=mock
npm run observe:down && npm run observe:up
```

---

### PostgreSQL: erro de conexão

```bash
# Verificar se postgres está healthy
docker inspect r-observe-postgres --format '{{.State.Health.Status}}'

# Testar conexão
docker exec r-observe-postgres psql -U postgres -c '\l'

# Ver logs
docker logs r-observe-postgres --tail 50
```

---

### Icinga2 não inicia

**Verificar validação de config:**
```bash
docker logs r-observe-icinga2 | grep -E "Error|critical|warning"
```

**Validar configuração manualmente:**
```bash
docker exec r-observe-icinga2 icinga2 daemon -C
```

---

### Menu lateral do IcingaWeb2 não aparece (sidebar vazia)

**Sintoma:** Após login em `http://localhost:3080/icinga/`, a sidebar exibe apenas
o logo e a busca — sem itens de navegação (Dashboard, Problems, Icinga DB…).

**Causa:** O CSS de branding da tela de login é injetado via `sub_filter` em
**todas** as páginas (`sub_filter_once off`). Se as regras `.orb` e `ul` não
estiverem escopadas para `#login`, o seletor `ul{display:none!important}` oculta
o `<ul class="nav nav-level-1">` da sidebar em todas as páginas autenticadas.

**Verificação rápida:**
```bash
# Height 0px = bug ativo; > 0px = OK
docker exec r-observe-proxy curl -s http://localhost:3080/icinga/layout/menu \
  | grep -c 'nav-level-1'
```

**Correção em `observe/nginx/conf.d/observe.conf`:**
```diff
- .orb{display:none!important}ul{display:none!important}
+ #login .orb{display:none!important}#login ul{display:none!important}
```

Após editar, recarregar sem derrubar o container:
```bash
docker exec r-observe-proxy nginx -t && docker exec r-observe-proxy nginx -s reload
```

---

### Nginx proxy retornando 502

**Serviço downstream não está rodando:**
```bash
docker ps --filter "name=r-observe"
```

**Verificar upstream no nginx:**
```bash
docker exec r-observe-proxy nginx -T 2>&1 | grep upstream
docker logs r-observe-proxy --tail 30
```

---

### Grafana sem dados

1. Verificar se Prometheus está coletando:
   ```
   http://localhost:3080/grafana → Explore → Prometheus → up
   ```
2. Verificar targets do Prometheus:
   ```bash
   docker exec r-observe-prometheus wget -qO- http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job:.labels.job, health:.health}'
   ```

---

## Resetar estado completo

> **Atenção:** destrói todos os dados.

```bash
npm run observe:down:volumes
# Remove volumes nomeados:
docker volume ls | grep observe | awk '{print $2}' | xargs docker volume rm
npm run observe:up:full
```

---

## Coletar diagnóstico completo

```bash
# Salvar snapshot de diagnóstico
{
  echo "=== docker ps ==="; docker ps --filter "name=r-observe"
  echo "=== API health ==="; curl -sf http://localhost:3080/observe/api/health
   echo "=== Worker logs ==="; docker logs r-observe-worker --tail 50 2>&1
   echo "=== API logs ==="; docker logs r-observe-api --tail 50 2>&1
  echo "=== Postgres health ==="; docker inspect r-observe-postgres --format '{{.State.Health.Status}}'
} > observe-diag-$(date +%Y%m%d-%H%M%S).txt
```
