#!/bin/bash
# ─── R-Observe: Validação do docker-compose ───────────────────────────────────
# Valida configuração, redes, volumes e portas da stack observe.
#
# Uso: ./scripts/observe/validate-compose.sh [--env-file <path>]
# ─────────────────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.observe.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES+1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
section() { echo -e "\n${BLUE}═══ $1 ═══${NC}"; }

FAILURES=0
PROFILE_ARGS="--profile observe-core --profile observe-ai --profile observe-agent --profile observe-icinga --profile observe-monitoring --profile r-observe-proxy --profile observe-discovery"

# ─── Argumentos ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ─── Pré-condições ────────────────────────────────────────────────────────────
section "Pré-condições"

[ -f "$COMPOSE_FILE" ] && pass "docker-compose.observe.yml existe" || { fail "docker-compose.observe.yml não encontrado em $COMPOSE_FILE"; exit 1; }

if [ -f "$ENV_FILE" ]; then
  pass ".env.observe encontrado: $ENV_FILE"
  COMPOSE_ARGS="--env-file ${ENV_FILE}"
elif [ -f "${ROOT_DIR}/.env.observe.example" ]; then
  warn ".env.observe não encontrado — usando .env.observe.example para validação de sintaxe"
  COMPOSE_ARGS="--env-file ${ROOT_DIR}/.env.observe.example"
else
  warn ".env.observe e .env.observe.example não encontrados — validação pode falhar em variáveis obrigatórias"
  COMPOSE_ARGS=""
fi

# ─── docker compose config ────────────────────────────────────────────────────
section "Validação do compose"

if docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS $PROFILE_ARGS config --quiet 2>&1; then
  pass "docker compose config: sem erros de sintaxe"
else
  fail "docker compose config falhou"
fi

# ─── Serviços esperados ───────────────────────────────────────────────────────
section "Serviços esperados"

EXPECTED_SERVICES=(
  "r-observe-postgres" "r-observe-redis"
  "r-observe-db-bootstrap"
  "r-observe-api" "r-observe-worker"
  "r-observe-ai" "r-observe-agent" "r-observe-discovery"
  "r-observe-icinga2" "r-observe-icingadb" "r-observe-icingaweb2" "r-observe-icinga-redis"
  "r-observe-prometheus" "r-observe-loki" "r-observe-grafana" "r-observe-otel-collector"
  "r-observe-proxy"
)

DEFINED_SERVICES=$(docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS $PROFILE_ARGS config --services 2>/dev/null)

for svc in "${EXPECTED_SERVICES[@]}"; do
  if echo "$DEFINED_SERVICES" | grep -q "^${svc}$"; then
    pass "Serviço definido: $svc"
  else
    fail "Serviço ausente: $svc"
  fi
done

# ─── Volumes ──────────────────────────────────────────────────────────────────
section "Volumes esperados"

EXPECTED_VOLUMES=(
  "r-observe-postgres-data" "r-observe-redis-data"
  "r-observe-icinga2-data"  "r-observe-icingaweb2-data" "r-observe-icingadb-data"
  "r-observe-prometheus-data" "r-observe-loki-data" "r-observe-grafana-data"
  "observe-evidence" "observe-replays" "observe-logs"
)

for vol in "${EXPECTED_VOLUMES[@]}"; do
  if docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS $PROFILE_ARGS config 2>/dev/null | grep -q "^  ${vol}:"; then
    pass "Volume definido: $vol"
  else
    warn "Volume não encontrado na saída do config: $vol (pode ser normal)"
  fi
done

# ─── Redes ────────────────────────────────────────────────────────────────────
section "Redes esperadas"

EXPECTED_NETWORKS=("observe-public" "observe-internal" "observe-monitoring" "observe-agent")

for net in "${EXPECTED_NETWORKS[@]}"; do
  if docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS $PROFILE_ARGS config 2>/dev/null | grep -q "^  ${net}:"; then
    pass "Rede definida: $net"
  else
    fail "Rede ausente: $net"
  fi
done

# ─── Segurança ────────────────────────────────────────────────────────────────
section "Validação de segurança"

COMPOSE_FULL=$(docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS $PROFILE_ARGS config 2>/dev/null)

if echo "$COMPOSE_FULL" | grep -Eq '^[[:space:]]*image:[[:space:]]+[^[:space:]]*:latest([[:space:]]|$)'; then
  fail "Compose contém imagem com tag flutuante latest"
else
  pass "Nenhuma imagem usa tag flutuante latest"
fi

UNPINNED_IMAGES=$(grep -E '^[[:space:]]+image:' "$COMPOSE_FILE" | grep -v '@sha256:' || true)
if [ -n "$UNPINNED_IMAGES" ]; then
  fail "Compose contém imagem externa sem digest imutável"
else
  pass "Todas as imagens externas estão fixadas por digest"
fi

UNPINNED_BASES=$(find "$ROOT_DIR/r-observe" "$ROOT_DIR/observe" \
  -path '*/node_modules/*' -prune -o \
  -name Dockerfile -type f -exec grep -H -E '^FROM ' {} \; \
  | grep -v -E '@sha256:|^.*:FROM scratch([[:space:]]|$)' || true)
if [ -n "$UNPINNED_BASES" ]; then
  fail "Dockerfile contém imagem-base sem digest imutável"
else
  pass "Todas as imagens-base dos Dockerfiles estão fixadas por digest"
fi

# Banco não deve ter porta exposta
if echo "$COMPOSE_FULL" | grep -A5 "container_name: r-observe-postgres" | grep -q "published:"; then
  fail "PostgreSQL tem porta exposta publicamente!"
else
  pass "PostgreSQL sem porta exposta"
fi

# Redis não deve ter porta exposta
if echo "$COMPOSE_FULL" | grep -A5 "container_name: r-observe-redis" | grep -q "published:"; then
  fail "Redis tem porta exposta publicamente!"
else
  pass "Redis sem porta exposta"
fi

# docker.sock deve ser somente leitura
SOCK_MOUNTS=$(grep -E "^[[:space:]]*-[[:space:]]*/var/run/docker.sock:/var/run/docker.sock" "$COMPOSE_FILE" | grep -v "#" || true)
SOCK_RW_COUNT=$(echo "$SOCK_MOUNTS" | grep -v ":ro" | grep -c "/var/run/docker.sock" || true)
if [ "$SOCK_RW_COUNT" -eq 0 ]; then
  pass "docker.sock somente leitura (ou ausente)"
else
  fail "docker.sock montado sem :ro!"
fi

# ─── Arquivos de config ────────────────────────────────────────────────────────
section "Arquivos de configuração"

CONFIG_FILES=(
  "${ROOT_DIR}/observe/nginx/nginx.conf"
  "${ROOT_DIR}/observe/nginx/conf.d/observe.conf"
  "${ROOT_DIR}/observe/prometheus/prometheus.yml"
  "${ROOT_DIR}/observe/loki/loki-config.yml"
  "${ROOT_DIR}/observe/otel/otel-collector-config.yml"
  "${ROOT_DIR}/observe/grafana/provisioning/datasources/observe.yml"
  "${ROOT_DIR}/observe/grafana/provisioning/dashboards/observe.yml"
  "${ROOT_DIR}/observe/postgres/init/01-observe-schema.sql"
  "${ROOT_DIR}/observe/postgres/init/02-icingadb-init.sh"
  "${ROOT_DIR}/observe/icinga2/Dockerfile"
  "${ROOT_DIR}/observe/icinga2/entrypoint.sh"
  "${ROOT_DIR}/r-observe/api/Dockerfile"
  "${ROOT_DIR}/r-observe/worker/Dockerfile"
  "${ROOT_DIR}/r-observe/ai/Dockerfile"
  "${ROOT_DIR}/r-observe/agent/Dockerfile"
  "${ROOT_DIR}/r-observe/discovery/Dockerfile"
)

for f in "${CONFIG_FILES[@]}"; do
  [ -f "$f" ] && pass "Existe: ${f#${ROOT_DIR}/}" || fail "Ausente: ${f#${ROOT_DIR}/}"
done

# ─── Resultado ────────────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}✔ Validação concluída: sem falhas.${NC}"
  exit 0
else
  echo -e "${RED}✘ Validação concluída com ${FAILURES} falha(s).${NC}"
  exit 1
fi
