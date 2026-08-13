#!/bin/bash
# ─── R-Observe: Smoke test de incidente end-to-end ───────────────────────────
# Simula o fluxo completo: agente → api → worker → incidente → IA → timeline.
#
# Uso: ./scripts/observe/smoke-observe-stack.sh [--api-url <url>] [--token <token>]
#
# Pré-requisitos:
#   - Stack observe-core (+ observe-ai para step 5) rodando
#   - Chave privada RS256 disponível ou token passado via --token
# ─────────────────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

# Carrega .env.observe se existir
[ -f "$ENV_FILE" ] && set -a && source "$ENV_FILE" && set +a

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
pass()    { echo -e "${GREEN}[PASS]${NC} $1"; }
fail()    { echo -e "${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES+1)); }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
section() { echo -e "\n${BLUE}═══ $1 ═══${NC}"; }
step()    { echo -e "${BLUE}[STEP $1]${NC} $2"; }

FAILURES=0
KEEP_DATA=false
EVENT_ID=""
INCIDENT_ID=""
SMOKE_HOST=""

resolve_observe_http_port() {
  local from_env_file
  from_env_file="${OBSERVE_HTTP_PORT:-}"
  if [[ -z "$from_env_file" ]]; then
    from_env_file="$(grep -m1 '^OBSERVE_HTTP_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  fi
  if [[ -z "$from_env_file" ]]; then
    echo "3080"
  else
    echo "$from_env_file"
  fi
}

# ─── Argumentos ───────────────────────────────────────────────────────────────
API_URL="${API_URL:-http://localhost:$(resolve_observe_http_port)}"
API_BASE="${R_OBSERVE_API_BASE_PATH:-/observe/api}"
_TOKEN_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --token)   _TOKEN_ARG="$2"; shift 2 ;;
    --keep-data) KEEP_DATA=true; shift ;;
    *) shift ;;
  esac
done

if [[ -n "$_TOKEN_ARG" ]]; then
  TOKEN="$_TOKEN_ARG"
else
  TOKEN="$(JWT_ROLE='admin' \
    JWT_SCOPE='api:access api:events:write api:remediation:write api:inventory:write' \
    node "${ROOT_DIR}/scripts/observe/jwt-sign.js" smoke-observe-stack 30m)"
fi

BASE="${API_URL}${API_BASE}"
AUTH_HEADER=""
[ -n "$TOKEN" ] && AUTH_HEADER="-H 'x-internal-token: ${TOKEN}'"

smoke_curl() {
  local url="$1"; shift
  curl -sf --max-time 10 -H "Content-Type: application/json" \
       ${TOKEN:+-H "x-internal-token: ${TOKEN}"} "$@" "$url"
}

cleanup_smoke_data() {
  [[ "$KEEP_DATA" == "true" || -z "$EVENT_ID" || -z "$SMOKE_HOST" ]] && return
  [[ "$EVENT_ID" =~ ^smoke-test-[0-9]+$ && "$SMOKE_HOST" =~ ^smoke-test-host-[0-9]+$ ]] || {
    warn "Cleanup recusado: identificadores sintéticos inválidos"
    return
  }
  if ! docker inspect r-observe-postgres >/dev/null 2>&1; then
    warn "Cleanup automático indisponível sem o container PostgreSQL local; use --keep-data para suprimir este aviso"
    return
  fi

  local cleanup_sql host_response
  cleanup_sql="DELETE FROM observe_incidents
    WHERE source_event_id = '${EVENT_ID}'
      AND host_id IN (SELECT id FROM observe_hosts WHERE name = '${SMOKE_HOST}');"
  if ! printf '%s\n' "$cleanup_sql" | docker exec -i r-observe-postgres \
      psql -v ON_ERROR_STOP=1 -U "${OBSERVE_DB_USER:-observe}" -d "${OBSERVE_DB_NAME:-observedb}" >/dev/null; then
    warn "Falha ao remover incidentes sintéticos do PostgreSQL"
    return
  fi

  host_response="$(smoke_curl "${BASE}/hosts/${SMOKE_HOST}" -X DELETE 2>/dev/null || true)"
  if echo "$host_response" | grep -Eq '"removed":true|Host não encontrado'; then
    pass "Cleanup removeu incidentes, remediações, timeline e host sintéticos"
  else
    warn "Incidentes sintéticos removidos; cleanup do host não foi confirmado"
  fi
}

trap cleanup_smoke_data EXIT

# ─── Step 1: API health ───────────────────────────────────────────────────────
section "Smoke Test de Incidente (10 steps)"
step 1 "Verificar health da API"

HEALTH=$(smoke_curl "${BASE}/health" 2>/dev/null || echo "ERRO")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  pass "API respondendo: ${BASE}/health"
else
  fail "API não responde: $HEALTH"
  echo -e "${RED}Stack não está pronta. Abortando smoke test.${NC}"
  exit 1
fi

# ─── Step 2: Status da API (DB + Redis) ──────────────────────────────────────
step 2 "Verificar status dos componentes (DB + Redis)"

STATUS=$(smoke_curl "${BASE}/status" 2>/dev/null || echo "ERRO")
if echo "$STATUS" | grep -q '"db":"ok"'; then
  pass "Banco de dados: OK"
else
  fail "Banco de dados com problema: $STATUS"
fi
if echo "$STATUS" | grep -q '"redis":"ok"'; then
  pass "Redis: OK"
else
  fail "Redis com problema: $STATUS"
fi

# ─── Step 3: Agente envia evento de container parado ─────────────────────────
step 3 "Agente detecta container parado e envia evento"

EVENT_ID="smoke-test-$(date +%s)"
SMOKE_HOST="smoke-test-host-${EVENT_ID##*-}"
EVENT_PAYLOAD="{
  \"type\": \"container.stopped\",
  \"id\": \"${EVENT_ID}\",
  \"source\": \"r-observe-agent\",
  \"host\": \"${SMOKE_HOST}\",
  \"address\": \"127.0.0.1\",
  \"severity\": \"warning\",
  \"service\": \"test-container\",
  \"container_id\": \"abc123def456\",
  \"state\": \"exited\",
  \"image\": \"alpine:latest\",
  \"message\": \"[SMOKE TEST] Container test-container está exited\"
}"

RESP=$(smoke_curl "${BASE}/events" -X POST -d "$EVENT_PAYLOAD" 2>/dev/null || echo "ERRO")
if echo "$RESP" | grep -q '"accepted":true'; then
  pass "Evento enviado: $EVENT_ID"
else
  fail "Evento rejeitado: $RESP"
fi

# ─── Step 4: Worker processa evento (aguarda) ────────────────────────────────
step 4 "Aguardando worker processar o evento (até 15s)"

MAX_WAIT=15
WAITED=0

while [ $WAITED -lt $MAX_WAIT ]; do
  INCIDENTS=$(smoke_curl "${BASE}/incidents" 2>/dev/null || echo "{}")
  # Busca incidente com source_event_id = EVENT_ID
  INCIDENT_ID=$(echo "$INCIDENTS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for i in data.get('incidents', []):
        if i.get('source_event_id') == '${EVENT_ID}':
            print(i['id'])
            break
except: pass
" 2>/dev/null || echo "")
  if [ -n "$INCIDENT_ID" ]; then
    break
  fi
  sleep 2
  WAITED=$((WAITED+2))
done

if [ -n "$INCIDENT_ID" ]; then
  pass "Incidente criado pelo worker: $INCIDENT_ID"
else
  fail "Worker não criou incidente no tempo esperado (${MAX_WAIT}s)"
  warn "Verifique se r-observe-worker está rodando: docker logs r-observe-worker"
fi

# ─── Step 5: IA gerou análise ────────────────────────────────────────────────
step 5 "Verificar análise de IA no incidente"

AI_SUMMARY=""
if [ -n "$INCIDENT_ID" ]; then
  # A análise de IA roda no mesmo ciclo do worker, mas alguns segundos após a
  # criação do incidente — aguarda até ~20s antes de concluir.
  AI_MAX_WAIT=20
  AI_WAITED=0
  while [ $AI_WAITED -lt $AI_MAX_WAIT ]; do
    INC_DETAIL=$(smoke_curl "${BASE}/incidents/${INCIDENT_ID}" 2>/dev/null || echo "{}")
    if echo "$INC_DETAIL" | grep -q '"ai_summary"'; then
      AI_SUMMARY=$(echo "$INC_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('incident',{}).get('ai_summary','')[:80])" 2>/dev/null || echo "")
      [ -n "$AI_SUMMARY" ] && break
    fi
    sleep 2
    AI_WAITED=$((AI_WAITED+2))
  done

  if [ -n "$AI_SUMMARY" ]; then
    pass "IA gerou análise: ${AI_SUMMARY}..."
  else
    warn "Campo ai_summary vazio após ${AI_MAX_WAIT}s (IA pode estar desabilitada ou sem provider configurado)"
  fi
fi

# ─── Step 6: Timeline criada ─────────────────────────────────────────────────
step 6 "Verificar timeline do incidente"

if [ -n "$INCIDENT_ID" ]; then
  INC_DETAIL=$(smoke_curl "${BASE}/incidents/${INCIDENT_ID}" 2>/dev/null || echo "{}")
  TIMELINE_COUNT=$(echo "$INC_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('timeline', [])))" 2>/dev/null || echo "0")
  if [ "$TIMELINE_COUNT" -gt 0 ]; then
    pass "Timeline com $TIMELINE_COUNT evento(s)"
  else
    fail "Timeline vazia"
  fi
fi

# ─── Step 7: Evidências ───────────────────────────────────────────────────────
step 7 "Verificar registro de incidente no banco"

if [ -n "$INCIDENT_ID" ]; then
  INC_DETAIL=$(smoke_curl "${BASE}/incidents/${INCIDENT_ID}" 2>/dev/null || echo "{}")
  if echo "$INC_DETAIL" | grep -q "\"id\":\"${INCIDENT_ID}\""; then
    pass "Incidente persistido no banco: $INCIDENT_ID"
  else
    fail "Incidente não encontrado no banco"
  fi
fi

# ─── Step 8: Status do incidente ─────────────────────────────────────────────
step 8 "Verificar status do incidente"

if [ -n "$INCIDENT_ID" ]; then
  INC_STATUS=$(echo "$INC_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('incident',{}).get('status',''))" 2>/dev/null || echo "")
  if [ "$INC_STATUS" = "open" ]; then
    pass "Incidente com status: open"
  else
    warn "Status do incidente: $INC_STATUS (esperado: open)"
  fi
fi

# ─── Step 9: IA criou remediação automática ──────────────────────────────────
step 9 "Verificar remediação criada pela IA (pending_approval ou auto-executada)"

REMEDIATION_ID=""
if [ -n "$INCIDENT_ID" ]; then
  # Aguarda até 10s para a remediação aparecer
  for i in $(seq 1 5); do
    PENDING=$(smoke_curl "${BASE}/remediation/pending" 2>/dev/null || echo "{}")
    REMEDIATION_ID=$(echo "$PENDING" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for r in data.get('remediations', []):
        if r.get('incident_id') == '${INCIDENT_ID}':
            print(r['id'])
            break
except: pass
" 2>/dev/null || echo "")
    [ -n "$REMEDIATION_ID" ] && break
    sleep 2
  done

  if [ -n "$REMEDIATION_ID" ]; then
    REM_ACTION=$(echo "$PENDING" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for r in data.get('remediations',[]):
    if r.get('id')=='${REMEDIATION_ID}':
        print(r.get('action','?'), '| score:', r.get('confidence_score','?'))
" 2>/dev/null || echo "")
    pass "Remediação pendente criada pela IA: ${REM_ACTION}"
  else
    # Pode ter sido auto-executada se score >= threshold
    INC_DETAIL2=$(smoke_curl "${BASE}/incidents/${INCIDENT_ID}" 2>/dev/null || echo "{}")
    HAS_REMEDIATION=$(echo "$INC_DETAIL2" | python3 -c "
import sys,json
data=json.load(sys.stdin)
events=[e for e in data.get('timeline',[]) if 'remediation' in e.get('event_type','')]
print(len(events))
" 2>/dev/null || echo "0")
    if [ "$HAS_REMEDIATION" -gt 0 ]; then
      pass "Remediação auto-executada (score acima do threshold)"
    else
      warn "Nenhuma remediação encontrada (IA pode estar em modo mock sem provider ou AI_ENABLED=false)"
    fi
  fi
fi

# ─── Step 10: Aprovar e executar remediação pendente ─────────────────────────
step 10 "Aprovar remediação via API e verificar execução"

if [ -n "$REMEDIATION_ID" ]; then
  APPROVE_RESP=$(smoke_curl "${BASE}/remediation/${REMEDIATION_ID}/approve" \
    -X POST -d '{"approved_by":"smoke-test"}' 2>/dev/null || echo "ERRO")
  if echo "$APPROVE_RESP" | grep -q '"approved"'; then
    pass "Remediação aprovada e enfileirada para execução"
  else
    fail "Aprovação falhou: $APPROVE_RESP"
  fi

  # Aguarda até 10s para o worker executar
  for i in $(seq 1 5); do
    sleep 2
    PENDING2=$(smoke_curl "${BASE}/remediation/pending" 2>/dev/null || echo "{}")
    STILL_PENDING=$(echo "$PENDING2" | python3 -c "
import sys,json
data=json.load(sys.stdin)
found=[r for r in data.get('remediations',[]) if r.get('id')=='${REMEDIATION_ID}']
print(len(found))
" 2>/dev/null || echo "1")
    [ "$STILL_PENDING" -eq 0 ] && break
  done

  if [ "$STILL_PENDING" -eq 0 ]; then
    pass "Remediação saiu de pending (executada ou falhou — verificar logs)"
  else
    warn "Remediação ainda pendente após 10s (worker pode não ter docker.sock ou container não existe)"
  fi
else
  warn "Step 10 pulado — nenhuma remediação pendente para aprovar"
fi

# ─── Resultado ────────────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}✔ Smoke test passou — ${FAILURES} falhas.${NC}"
  exit 0
else
  echo -e "${RED}✘ Smoke test com ${FAILURES} falha(s).${NC}"
  echo ""
  echo "Diagnóstico:"
  echo "  docker logs r-observe-api"
  echo "  docker logs r-observe-worker"
  echo "  docker logs r-observe-ai"
  echo "  npm run observe:logs"
  exit 1
fi
