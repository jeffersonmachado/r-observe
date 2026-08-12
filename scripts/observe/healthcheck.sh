#!/bin/bash
# ─── R-Observe: Healthcheck da stack ─────────────────────────────────────────
# Verifica o status de saúde de todos os containers da stack observe.
#
# Uso: ./scripts/observe/healthcheck.sh [--env-file <path>]
# ─────────────────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.observe.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
pass() { echo -e "${GREEN}[HEALTHY]${NC} $1"; }
fail() { echo -e "${RED}[UNHEALTHY]${NC} $1"; FAILURES=$((FAILURES+1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
section() { echo -e "\n${BLUE}═══ $1 ═══${NC}"; }

FAILURES=0
COMPOSE_ARGS="--env-file ${ENV_FILE}"
[ -f "$ENV_FILE" ] || COMPOSE_ARGS=""

# ─── Status de containers em execução ────────────────────────────────────────
section "Status dos containers"

RUNNING_CONTAINERS=$(docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS ps --format json 2>/dev/null || echo "[]")

check_container() {
  local name="$1"
  local state health
  state=$(docker inspect --format='{{.State.Status}}' "$name" 2>/dev/null || echo "missing")
  health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo "none")

  if [[ "$state" == "missing" ]]; then
    warn "Container não encontrado: $name (profile pode não estar ativo)"
    return
  fi

  if [ "$state" = "running" ] && ([ "$health" = "healthy" ] || [ "$health" = "none" ]); then
    pass "$name (state=$state, health=$health)"
  elif [ "$state" = "running" ] && [ "$health" = "starting" ]; then
    warn "$name STARTING (aguardando healthcheck)"
  else
    fail "$name (state=$state, health=$health)"
  fi
}

CONTAINERS=(
  "r-observe-postgres" "r-observe-redis"
  "r-observe-api" "r-observe-worker"
  "r-observe-ai" "r-observe-agent"
  "r-observe-icinga2" "r-observe-icingadb" "r-observe-icingaweb2" "r-observe-icinga-redis"
  "r-observe-prometheus" "r-observe-loki" "r-observe-grafana" "r-observe-otel-collector"
  "r-observe-proxy"
)

for c in "${CONTAINERS[@]}"; do
  check_container "$c"
done

# ─── Endpoint health checks ───────────────────────────────────────────────────
section "Endpoint health checks"

BASE_URL="${OBSERVE_HEALTH_BASE:-http://localhost:3080}"

check_endpoint() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local status
  status=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
  if [ "$status" = "$expected" ]; then
    pass "$label → $url ($status)"
  else
    fail "$label → $url (esperado: $expected, obtido: $status)"
  fi
}

# Serviços internos não publicam portas no host por desenho. A saúde deles já
# foi verificada pelos healthchecks dos containers acima; daqui em diante são
# testados apenas os endpoints realmente expostos pelo proxy.
if docker inspect r-observe-proxy >/dev/null 2>&1; then
  check_endpoint "proxy /observe/api/health" "${BASE_URL}/observe/api/health"
  check_endpoint "proxy /observe/proxy/health" "${BASE_URL}/observe/proxy/health"
fi

# ─── Resultado ────────────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}✔ Stack healthy: sem falhas.${NC}"
  exit 0
else
  echo -e "${RED}✘ Stack com ${FAILURES} falha(s).${NC}"
  exit 1
fi
