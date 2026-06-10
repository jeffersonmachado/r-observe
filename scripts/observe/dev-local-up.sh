#!/bin/bash
# Sobe apenas dependências locais do dev híbrido: PostgreSQL e Redis em containers.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"
CHECK_ONLY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY="true"; shift ;;
    *) shift ;;
  esac
done

log() { echo "[dev-local-up] $*"; }
fail() { echo "[dev-local-up] FAIL: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || fail "arquivo .env.observe não encontrado em $ENV_FILE"
set -a
. "$ENV_FILE"
set +a

command -v docker >/dev/null 2>&1 || fail "docker não encontrado"
docker compose version >/dev/null 2>&1 || fail "docker compose não encontrado"

DB_NAME="${OBSERVE_DB_NAME:-observedb}"
DB_USER="${OBSERVE_DB_USER:-observe}"
DB_PORT="${OBSERVE_DB_PORT:-5432}"
REDIS_PORT="${OBSERVE_REDIS_PORT:-6379}"

if [[ "$CHECK_ONLY" != "true" ]]; then
  # Libera portas usadas pelo dev local (mata processos órfãos de sessões anteriores)
  DEV_PORTS="${OBSERVE_API_PORT:-3009} ${OBSERVE_DISCOVERY_PORT:-3010} ${OBSERVE_AI_PORT:-3011} ${VITE_DEV_PORT:-5177}"
  for port in $DEV_PORTS; do
    pid="$(lsof -ti:"${port}" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      log "liberando porta ${port} (PID ${pid})"
      kill -TERM $pid 2>/dev/null || true
    fi
  done
  # Aguarda liberação graceful; SIGKILL em quem persistir
  sleep 1
  for port in $DEV_PORTS; do
    pid="$(lsof -ti:"${port}" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      log "forçando encerramento porta ${port} (PID ${pid})"
      kill -KILL $pid 2>/dev/null || true
    fi
  done

  log "subindo dependências r-observe-postgres e r-observe-redis"
  docker compose -f "$ROOT_DIR/docker-compose.observe.yml" --env-file "$ENV_FILE" --profile observe-core up -d r-observe-postgres r-observe-redis
else
  log "modo check-only: validando dependências sem iniciar containers"
fi

for service in r-observe-postgres r-observe-redis; do
  if ! docker ps --filter "name=${service}" --filter status=running --format "{{.Names}}" | grep -Fxq "$service"; then
    fail "container ${service} não está em execução"
  fi
done

for _ in {1..40}; do
  PG_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' r-observe-postgres 2>/dev/null || true)"
  REDIS_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' r-observe-redis 2>/dev/null || true)"
  if [[ "$PG_STATUS" == "healthy" && "$REDIS_STATUS" == "healthy" ]]; then
    break
  fi
  sleep 2
done

PG_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' r-observe-postgres 2>/dev/null || true)"
REDIS_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' r-observe-redis 2>/dev/null || true)"
[[ "$PG_STATUS" == "healthy" ]] || fail "PostgreSQL não ficou healthy (status=$PG_STATUS)"
[[ "$REDIS_STATUS" == "healthy" ]] || fail "Redis não ficou healthy (status=$REDIS_STATUS)"

docker exec r-observe-postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null || fail "PostgreSQL não respondeu pg_isready"
if [[ -n "${OBSERVE_REDIS_PASSWORD:-}" ]]; then
  docker exec r-observe-redis redis-cli -a "$OBSERVE_REDIS_PASSWORD" ping | grep -q PONG || fail "Redis não respondeu PONG"
else
  docker exec r-observe-redis redis-cli ping | grep -q PONG || fail "Redis não respondeu PONG"
fi

# Detecta IPs reais dos containers (rede internal não publica portas no host)
POSTGRES_CONTAINER_IP="$(docker inspect r-observe-postgres --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || true)"
REDIS_CONTAINER_IP="$(docker inspect r-observe-redis --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || true)"
# Verifica se host chega ao container via port forwarding; senão usa IP direto
EFFECTIVE_DB_HOST="${POSTGRES_CONTAINER_IP:-127.0.0.1}"
EFFECTIVE_REDIS_HOST="${REDIS_CONTAINER_IP:-127.0.0.1}"
cat > /tmp/.r-observe-hosts <<_HOSTS
DB_HOST="${EFFECTIVE_DB_HOST}"
DB_PORT=5432
REDIS_HOST="${EFFECTIVE_REDIS_HOST}"
_HOSTS
log "dependências prontas: PostgreSQL ${EFFECTIVE_DB_HOST}:${DB_PORT}, Redis ${EFFECTIVE_REDIS_HOST}:${REDIS_PORT}"
