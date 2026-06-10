#!/usr/bin/env bash
# ─── smoke-icinga.sh ──────────────────────────────────────────────────────────
# Valida a integração Icinga2 → R-Observe de ponta a ponta.
#
# Passos verificados:
#   1. Icinga2 container está healthy
#   2. API Icinga2 responde (via docker exec)
#   3. IcingaDB está sincronizando (tabela no PostgreSQL tem objetos)
#   4. IcingaWeb2 está acessível
#   5. R-Observe API aceita evento de notificação Icinga
#   6. Worker processa o evento e cria incidente com source=icinga
#   7. Incidente criado tem os campos esperados
#   8. Evento de recovery fecha o incidente
#
# Uso:
#   ./scripts/observe/smoke-icinga.sh
#   OBSERVE_HTTP_PORT=3080 ./scripts/observe/smoke-icinga.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../../.env.observe"

# ── Cores ──────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass() { echo -e "${GREEN}[PASS]${RESET} $*"; }
fail() { echo -e "${RED}[FAIL]${RESET} $*"; FAILED=$((FAILED+1)); }
info() { echo -e "${CYAN}[info]${RESET} $*"; }
FAILED=0
STEP=0

step() {
  STEP=$((STEP+1))
  echo -e "\n${BOLD}Step ${STEP}: $*${RESET}"
}

# ── Carrega .env.observe ───────────────────────────────────────────────────────
[[ -f "${ENV_FILE}" ]] || { echo "ERRO: .env.observe não encontrado em ${ENV_FILE}"; exit 1; }

_get_env() {
  grep -m1 "^${1}=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'"
}

_resolve_port() {
  local p
  p="${OBSERVE_HTTP_PORT:-$(_get_env OBSERVE_HTTP_PORT)}"
  if [[ -z "${p}" ]]; then
    echo "3080"
  else
    echo "${p}"
  fi
}

API_BASE="http://localhost:$(_resolve_port)/observe/api"
_SECRET="${JWT_SECRET:-$(_get_env JWT_SECRET)}"
ICINGA_USER="${ICINGA_API_USER:-$(_get_env ICINGA_API_USER)}"
ICINGA_PASS="${ICINGA_API_PASSWORD:-$(_get_env ICINGA_API_PASSWORD)}"
ICINGA_CONTAINER="r-observe-icinga2"
ICINGA_DB_CONTAINER="r-observe-postgres"
ICINGA_DB_NAME="${ICINGADB_DB_NAME:-$(_get_env ICINGADB_DB_NAME)}"
ICINGA_DB_USER="${ICINGADB_DB_USER:-$(_get_env ICINGADB_DB_USER)}"
ICINGA_DB_NAME="${ICINGA_DB_NAME:-icingadb}"
ICINGA_DB_USER="${ICINGA_DB_USER:-icingadb}"

[[ -z "${_SECRET}" ]] && { echo "ERRO: JWT_SECRET não definido em .env.observe"; exit 1; }
TOKEN="$(node "${SCRIPT_DIR}/jwt-sign.js" smoke-icinga 30m)"
[[ -z "${ICINGA_PASS}" ]] && { echo "ERRO: ICINGA_API_PASSWORD não definido em .env.observe"; exit 1; }

# Identificador único para este smoke test (evita colisão com dados reais)
TEST_HOST="smoke-test-icinga-$$"
TEST_ID="smoke-$(date +%s)"

echo -e "${BOLD}── R-Observe: smoke test Icinga ──────────────────────────────${RESET}"
info "API base: ${API_BASE}"
info "Container Icinga2: ${ICINGA_CONTAINER}"

# ── Step 1: Icinga2 container healthy ─────────────────────────────────────────
step "Icinga2 container está healthy"
STATUS=$(docker inspect --format='{{.State.Health.Status}}' "${ICINGA_CONTAINER}" 2>/dev/null || echo "not_found")
if [[ "${STATUS}" == "healthy" ]]; then
  pass "Container ${ICINGA_CONTAINER}: ${STATUS}"
else
  fail "Container ${ICINGA_CONTAINER}: ${STATUS} (esperado: healthy)"
  [[ "${STATUS}" == "not_found" ]] && { echo "  Suba o stack com --profile observe-icinga primeiro."; exit 1; }
fi

# ── Step 2: API Icinga2 responde ───────────────────────────────────────────────
step "API Icinga2 responde"
ICINGA_RESP=$(docker exec "${ICINGA_CONTAINER}" curl -sk \
  -u "${ICINGA_USER}:${ICINGA_PASS}" \
  -o /dev/null -w "%{http_code}" \
  https://127.0.0.1:5665/v1/status/IcingaApplication 2>/dev/null || echo "000")
if [[ "${ICINGA_RESP}" == "200" ]]; then
  pass "Icinga2 REST API respondeu HTTP ${ICINGA_RESP}"
else
  fail "Icinga2 REST API retornou HTTP ${ICINGA_RESP} (esperado 200)"
fi

# ── Step 3: IcingaDB sincronizando ────────────────────────────────────────────
step "IcingaDB sincronizando com PostgreSQL"
ICINGADB_COUNT=$(docker exec "${ICINGA_DB_CONTAINER}" \
  psql -U "${ICINGA_DB_USER}" -d "${ICINGA_DB_NAME}" -tAc \
  "SELECT COUNT(*) FROM host;" 2>/dev/null | tr -d '[:space:]' || echo "error")
if [[ "${ICINGADB_COUNT}" =~ ^[0-9]+$ ]]; then
  pass "Tabela 'host' no IcingaDB tem ${ICINGADB_COUNT} registro(s)"
  [[ "${ICINGADB_COUNT}" -eq 0 ]] && info "  Nenhum host ainda — execute discover-hosts.sh para popular."
else
  fail "Não foi possível consultar tabela 'host' no IcingaDB (${ICINGADB_COUNT})"
  info "  Verifique se r-observe-icingadb está saudável e o schema foi criado."
fi

# ── Step 4: IcingaWeb2 acessível ──────────────────────────────────────────────
step "IcingaWeb2 acessível"
IWEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 5 "${API_BASE%/observe/api}/icinga/" 2>/dev/null || echo "000")
if [[ "${IWEB_CODE}" =~ ^(200|302|301)$ ]]; then
  pass "IcingaWeb2 respondeu HTTP ${IWEB_CODE}"
else
  fail "IcingaWeb2 retornou HTTP ${IWEB_CODE} (esperado 200/30x)"
fi

# ── Step 5: R-Observe API aceita evento Icinga ─────────────────────────────────
step "R-Observe API aceita evento de notificação Icinga"
EVENT_PAYLOAD=$(cat <<EOF
{
  "type": "host.down",
  "notification_type": "PROBLEM",
  "host": "${TEST_HOST}",
  "address": "10.255.254.1",
  "state": "DOWN",
  "output": "PING CRITICAL - Packet loss = 100%",
  "source": "icinga",
  "id": "${TEST_ID}"
}
EOF
)
EVENT_RESP=$(curl -sf -o /dev/null -w "%{http_code}" \
  -X POST "${API_BASE}/icinga/events" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: ${TOKEN}" \
  -d "${EVENT_PAYLOAD}" 2>/dev/null || echo "000")
if [[ "${EVENT_RESP}" == "202" ]]; then
  pass "Evento aceito (HTTP 202)"
else
  fail "API retornou HTTP ${EVENT_RESP} (esperado 202)"
fi

# ── Step 6: Worker cria incidente ─────────────────────────────────────────────
step "Worker processa evento e cria incidente com source=icinga"
info "Aguardando até 15s para o worker processar..."
INCIDENT_ID=""
for i in $(seq 1 15); do
  sleep 1
  INCIDENT_ID=$(curl -sf \
    "${API_BASE}/incidents" \
    -H "x-internal-token: ${TOKEN}" 2>/dev/null | \
    python3 -c "
import json,sys
d=json.load(sys.stdin)
for i in d.get('incidents',[]):
  if i.get('source')=='icinga' and '${TEST_HOST}' in i.get('title',''):
    print(i['id'])
    break
" 2>/dev/null || echo "")
  [[ -n "${INCIDENT_ID}" ]] && break
done

if [[ -n "${INCIDENT_ID}" ]]; then
  pass "Incidente criado: ${INCIDENT_ID}"
else
  fail "Worker não criou incidente com source=icinga para ${TEST_HOST} em 15s"
fi

# ── Step 7: Incidente tem campos esperados ────────────────────────────────────
step "Incidente tem campos esperados (severity, title, source)"
if [[ -n "${INCIDENT_ID}" ]]; then
  INCIDENT_JSON=$(curl -sf \
    "${API_BASE}/incidents/${INCIDENT_ID}" \
    -H "x-internal-token: ${TOKEN}" 2>/dev/null || echo "{}")
  python3 - "${INCIDENT_JSON}" <<'PYEOF'
import json, sys
data = json.loads(sys.argv[1])
inc  = data.get("incident", {})
ok   = True
checks = [
    ("source",   inc.get("source"),   "icinga"),
    ("severity", inc.get("severity"), lambda v: v in ("critical","warning")),
    ("status",   inc.get("status"),   "open"),
    ("title",    inc.get("title"),    lambda v: bool(v)),
]
for field, got, expected in checks:
    if callable(expected):
        passed = expected(got)
    else:
        passed = (got == expected)
    mark = "\033[0;32m[PASS]\033[0m" if passed else "\033[0;31m[FAIL]\033[0m"
    print(f"  {mark} {field}: {repr(got)}")
    if not passed:
        ok = False
sys.exit(0 if ok else 1)
PYEOF
  [[ $? -eq 0 ]] && pass "Todos os campos verificados" || { fail "Campos inválidos no incidente"; }
else
  info "  (pulado — incidente não foi criado no step 6)"
fi

# ── Step 8: Recovery fecha o incidente ───────────────────────────────────────
step "Evento de recovery fecha o incidente"
RECOVERY_PAYLOAD=$(cat <<EOF
{
  "type": "host.recovery",
  "notification_type": "RECOVERY",
  "host": "${TEST_HOST}",
  "address": "10.255.254.1",
  "state": "UP",
  "output": "PING OK",
  "source": "icinga",
  "id": "${TEST_ID}-recovery"
}
EOF
)
curl -sf -o /dev/null \
  -X POST "${API_BASE}/icinga/events" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: ${TOKEN}" \
  -d "${RECOVERY_PAYLOAD}" 2>/dev/null || true

if [[ -n "${INCIDENT_ID}" ]]; then
  FINAL_STATUS="unknown"
  for _ in $(seq 1 15); do
    FINAL_STATUS=$(curl -sf \
      "${API_BASE}/incidents/${INCIDENT_ID}" \
      -H "x-internal-token: ${TOKEN}" 2>/dev/null | \
      python3 -c "import json,sys; print(json.load(sys.stdin)['incident']['status'])" 2>/dev/null || echo "unknown")
    [[ "${FINAL_STATUS}" == "resolved" ]] && break
    sleep 2
  done
  if [[ "${FINAL_STATUS}" == "resolved" ]]; then
    pass "Incidente fechado (status: resolved)"
  else
    fail "Incidente não foi fechado (status: ${FINAL_STATUS})"
  fi
else
  info "  (pulado — incidente não foi criado no step 6)"
fi

# ── Resultado final ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}─────────────────────────────────────────────────────────────${RESET}"
if [[ "${FAILED}" -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}[SMOKE] Todos os ${STEP} steps passaram ✓${RESET}"
  exit 0
else
  echo -e "${RED}${BOLD}[SMOKE] ${FAILED} step(s) falharam de ${STEP}${RESET}"
  exit 1
fi
