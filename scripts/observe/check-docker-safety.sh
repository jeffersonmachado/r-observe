#!/bin/bash
# ─── R-Observe: Validação de segurança Docker ────────────────────────────────
# Verifica boas práticas de segurança na stack observe.
#
# Uso: ./scripts/observe/check-docker-safety.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.observe.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
pass() { echo -e "${GREEN}[SAFE]${NC} $1"; }
fail() { echo -e "${RED}[RISK]${NC} $1"; FAILURES=$((FAILURES+1)); }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
section() { echo -e "\n${BLUE}═══ $1 ═══${NC}"; }

FAILURES=0
COMPOSE_ARGS="--env-file ${ENV_FILE}"
[ -f "$ENV_FILE" ] || COMPOSE_ARGS=""

COMPOSE_FULL=$(docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS config 2>/dev/null || true)

# ─── Banco de dados ────────────────────────────────────────────────────────────
section "Banco de dados"
docker inspect observe-postgres >/dev/null 2>&1 && {
  PORTS=$(docker inspect observe-postgres | python3 -c "import sys,json; d=json.load(sys.stdin); ports=d[0].get('NetworkSettings',{}).get('Ports',{}); print(next(iter(ports),None))" 2>/dev/null || echo "")
  HOST_BIND=$(docker inspect observe-postgres | python3 -c "import sys,json; d=json.load(sys.stdin); ports=d[0].get('NetworkSettings',{}).get('Ports',{}); binds=list(ports.values()); print(binds[0][0]['HostIp'] if binds and binds[0] else 'none')" 2>/dev/null || echo "none")
  if [ "$HOST_BIND" = "none" ]; then
    pass "PostgreSQL sem porta exposta no host"
  else
    fail "PostgreSQL exposto no host (IP: $HOST_BIND) — banco não deve ser acessível externamente!"
  fi
} || warn "observe-postgres não está rodando"

# ─── Redis ─────────────────────────────────────────────────────────────────────
section "Redis"
docker inspect observe-redis >/dev/null 2>&1 && {
  REDIS_BIND=$(docker inspect observe-redis | python3 -c "import sys,json; d=json.load(sys.stdin); ports=d[0].get('NetworkSettings',{}).get('Ports',{}); binds=list(ports.values()); print(binds[0][0]['HostIp'] if binds and binds[0] else 'none')" 2>/dev/null || echo "none")
  if [ "$REDIS_BIND" = "none" ]; then
    pass "Redis sem porta exposta no host"
  else
    fail "Redis exposto no host — não deve ser acessível externamente!"
  fi
} || warn "observe-redis não está rodando"

# ─── docker.sock ──────────────────────────────────────────────────────────────
section "Docker socket"
docker inspect r-observe-agent >/dev/null 2>&1 && {
  SOCK_MODE=$(docker inspect r-observe-agent | python3 -c "
import sys, json
d = json.load(sys.stdin)
mounts = d[0].get('Mounts', [])
for m in mounts:
    if 'docker.sock' in m.get('Source', ''):
        print(m.get('Mode', 'unknown'))
        break
else:
    print('not_mounted')
" 2>/dev/null || echo "unknown")
  if [ "$SOCK_MODE" = "ro" ]; then
    pass "docker.sock montado como read-only no agente"
  elif [ "$SOCK_MODE" = "not_mounted" ]; then
    warn "docker.sock não montado no agente"
  else
    fail "docker.sock montado com modo '$SOCK_MODE' (esperado: ro)"
  fi
} || warn "r-observe-agent não está rodando"

# ─── no-new-privileges ────────────────────────────────────────────────────────
section "no-new-privileges"

OBSERVE_CONTAINERS=("observe-postgres" "observe-redis" "r-observe-api" "r-observe-worker" "r-observe-ai" "r-observe-agent" "observe-proxy")

for c in "${OBSERVE_CONTAINERS[@]}"; do
  docker inspect "$c" >/dev/null 2>&1 && {
    NNP=$(docker inspect "$c" | python3 -c "
import sys, json
d = json.load(sys.stdin)
opts = d[0].get('HostConfig', {}).get('SecurityOpt', [])
print('yes' if any('no-new-privileges:true' in o for o in opts) else 'no')
" 2>/dev/null || echo "no")
    if [ "$NNP" = "yes" ]; then
      pass "$c: no-new-privileges=true"
    else
      warn "$c: no-new-privileges não configurado"
    fi
  } || true
done

# ─── Rotação de logs ──────────────────────────────────────────────────────────
section "Rotação de logs"

for c in "${OBSERVE_CONTAINERS[@]}"; do
  docker inspect "$c" >/dev/null 2>&1 && {
    LOG_DRIVER=$(docker inspect "$c" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('HostConfig',{}).get('LogConfig',{}).get('Type','default'))" 2>/dev/null || echo "default")
    MAX_SIZE=$(docker inspect "$c" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0].get('HostConfig',{}).get('LogConfig',{}).get('Config',{}).get('max-size','none'))" 2>/dev/null || echo "none")
    if [ "$MAX_SIZE" != "none" ]; then
      pass "$c: log max-size=$MAX_SIZE"
    else
      warn "$c: sem max-size de log configurado"
    fi
  } || true
done

# ─── Variáveis sensíveis no .env ──────────────────────────────────────────────
section "Variáveis de ambiente"
if [ -f "$ENV_FILE" ]; then
  CHANGE_ME_COUNT=$(grep -c "CHANGE_ME" "$ENV_FILE" 2>/dev/null || echo "0")
  if [ "$CHANGE_ME_COUNT" -gt 0 ]; then
    fail "Existem $CHANGE_ME_COUNT valor(es) CHANGE_ME no .env.observe — altere antes de produção!"
  else
    pass "Nenhum valor CHANGE_ME no .env.observe"
  fi
  # Verifica se .env.observe está no .gitignore
  if grep -q "\.env\.observe$\|\.env\.observe " "${ROOT_DIR}/.gitignore" 2>/dev/null; then
    pass ".env.observe está no .gitignore"
  else
    warn ".env.observe não encontrado no .gitignore — verifique para não commitar segredos"
  fi
fi

# ─── Resultado ────────────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}✔ Validação de segurança: sem riscos críticos.${NC}"
  exit 0
else
  echo -e "${RED}✘ ${FAILURES} risco(s) crítico(s) encontrado(s). Corrija antes de produção.${NC}"
  exit 1
fi
