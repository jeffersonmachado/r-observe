#!/usr/bin/env bash
# ─── deploy-remote.sh ─────────────────────────────────────────────────────────
# Deploy remoto da stack R-Observe no servidor 10.10.2.30.
#
# Gerencia automaticamente a conexao VPN via /opt/results/rvpn/rvpn.sh
# quando o servidor nao esta acessivel diretamente.
#
# Uso:
#   ./scripts/observe/deploy-remote.sh                    # deploy completo
#   ./scripts/observe/deploy-remote.sh --service discovery  # apenas discovery
#   ./scripts/observe/deploy-remote.sh --service api        # apenas api
#   ./scripts/observe/deploy-remote.sh --service all        # todos (default)
#   ./scripts/observe/deploy-remote.sh --no-build           # sem rebuild
#   ./scripts/observe/deploy-remote.sh --skip-smoke         # sem smoke tests
#   ./scripts/observe/deploy-remote.sh --skip-vpn           # pula checagem VPN
#   ./scripts/observe/deploy-remote.sh --skip-sync          # pula rsync
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

# ── Configuracoes ─────────────────────────────────────────────────────────────
REMOTE_HOST="${DEPLOY_HOST:-10.10.2.30}"
REMOTE_USER="${DEPLOY_USER:-root}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/results/r-observe}"
SSH_PASSWORD="${SSH_PASSWORD:-${DEPLOY_SSH_PASSWORD:-}}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=30"

COMPOSE_FILE="docker-compose.observe.yml"
ENV_FILE=".env.observe"
PROFILE="observe-core"
SERVICE="${SERVICE:-all}"

NO_BUILD=false
SKIP_SMOKE=false
SKIP_VPN=false
SKIP_SYNC=false

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

step() { echo -e "\n${BOLD}${CYAN}▶ $*${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
die()  { echo -e "${RED}ERRO:${RESET} $*" >&2; exit 1; }

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)     SERVICE="$2";    shift 2 ;;
    --no-build)    NO_BUILD=true;   shift   ;;
    --skip-smoke)  SKIP_SMOKE=true; shift   ;;
    --skip-vpn)    SKIP_VPN=true;   shift   ;;
    --skip-sync)   SKIP_SYNC=true;  shift   ;;
    --host)        REMOTE_HOST="$2"; shift 2 ;;
    --user)        REMOTE_USER="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# *//'
      exit 0
      ;;
    *) die "Argumento desconhecido: $1" ;;
  esac
done

# ── Funcoes SSH ───────────────────────────────────────────────────────────────
run_ssh() {
  if [[ -n "${SSH_PASSWORD}" ]]; then
    sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" "$@"
  else
    ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" "$@"
  fi
}

run_ssh_silent() {
  run_ssh "$@" 2>/dev/null
}

# ── VPN ───────────────────────────────────────────────────────────────────────
VPN_SCRIPT="/opt/results/rvpn/rvpn.sh"

ensure_vpn() {
  if [[ "$SKIP_VPN" == "true" ]]; then
    warn "Checagem de VPN pulada (--skip-vpn)"
    return 0
  fi

  step "Verificando conectividade com ${REMOTE_HOST}..."

  if ping -c 1 -W 3 "${REMOTE_HOST}" >/dev/null 2>&1; then
    ok "Servidor ${REMOTE_HOST} acessivel diretamente"
    return 0
  fi

  warn "Servidor ${REMOTE_HOST} nao acessivel diretamente"

  if [[ ! -f "${VPN_SCRIPT}" ]]; then
    die "Script de VPN nao encontrado: ${VPN_SCRIPT}"
  fi

  step "Conectando VPN via ${VPN_SCRIPT}..."
  if "${VPN_SCRIPT}" auto; then
    ok "VPN conectada com sucesso"

    # Verifica conectividade apos VPN
    if ping -c 1 -W 3 "${REMOTE_HOST}" >/dev/null 2>&1; then
      ok "Servidor ${REMOTE_HOST} acessivel via VPN"
    else
      die "VPN conectada mas ${REMOTE_HOST} ainda nao acessivel"
    fi
  else
    die "Falha ao conectar VPN"
  fi
}

# ── Pre-check ─────────────────────────────────────────────────────────────────
pre_check() {
  step "Pre-check local"

  command -v rsync  >/dev/null 2>&1 || die "rsync nao encontrado"
  command -v ssh    >/dev/null 2>&1 || die "ssh nao encontrado"

  if [[ -n "${SSH_PASSWORD}" ]]; then
    command -v sshpass >/dev/null 2>&1 || die "sshpass nao encontrado (necessario para autenticacao por senha)"
    export SSHPASS="${SSH_PASSWORD}"
  fi

  if [[ ! -f "${ENV_FILE}" ]]; then
    die "${ENV_FILE} nao encontrado no diretorio raiz"
  fi

  ok "Pre-check concluido"
}

# ── Sync ──────────────────────────────────────────────────────────────────────
sync_code() {
  if [[ "$SKIP_SYNC" == "true" ]]; then
    warn "Sync de codigo pulado (--skip-sync)"
    return 0
  fi

  step "Sincronizando codigo para ${REMOTE_HOST}:${REMOTE_DIR}..."

  local rsync_args=(
    -az --delete
    --exclude='.env*'
    --exclude='node_modules'
    --exclude='.git'
    --exclude='dist'
    --exclude='test-results'
    --exclude='playwright-report'
    --exclude='secrets'
    --exclude='backups'
    --exclude='*.log'
  )

  if [[ -n "${SSH_PASSWORD}" ]]; then
    sshpass -p "${SSH_PASSWORD}" rsync "${rsync_args[@]}" \
      -e "ssh ${SSH_OPTS}" \
      "${REPO_ROOT}/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
  else
    rsync "${rsync_args[@]}" \
      -e "ssh ${SSH_OPTS}" \
      "${REPO_ROOT}/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
  fi

  ok "Codigo sincronizado"
}

# ── Build ─────────────────────────────────────────────────────────────────────
build_on_remote() {
  if [[ "$NO_BUILD" == "true" ]]; then
    warn "Build pulado (--no-build)"
    return 0
  fi

  step "Build das imagens Docker no servidor..."

  local build_cmd="cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} build"

  case "${SERVICE}" in
    all)
      build_cmd="${build_cmd} r-observe-api r-observe-discovery r-observe-worker"
      ;;
    api)
      build_cmd="${build_cmd} r-observe-api"
      ;;
    discovery)
      build_cmd="${build_cmd} r-observe-discovery"
      ;;
    worker)
      build_cmd="${build_cmd} r-observe-worker"
      ;;
    *)
      die "Servico desconhecido: ${SERVICE} (use: all, api, discovery, worker)"
      ;;
  esac

  run_ssh "${build_cmd}"
  ok "Build concluido"
}

# ── Restart ───────────────────────────────────────────────────────────────────
restart_services() {
  step "Reiniciando containers no servidor..."

  local up_cmd="cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} --profile ${PROFILE} up -d"

  case "${SERVICE}" in
    all)
      # Recria todos com --no-deps para nao reiniciar dependencias (postgres, redis)
      run_ssh "${up_cmd} --no-deps r-observe-api r-observe-discovery r-observe-worker"
      ;;
    api|discovery|worker)
      run_ssh "${up_cmd} --no-deps r-observe-${SERVICE}"
      ;;
  esac

  ok "Containers reiniciados"

  # Aguarda health checks
  step "Aguardando health checks..."
  sleep 8

  local healthy
  case "${SERVICE}" in
    all)
      healthy=$(run_ssh "docker ps --filter name=r-observe-api --filter name=r-observe-discovery --filter name=r-observe-worker --format '{{.Names}} {{.Status}}' | grep -v '(healthy)' || true")
      ;;
    *)
      healthy=$(run_ssh "docker ps --filter name=r-observe-${SERVICE} --format '{{.Names}} {{.Status}}' | grep -v '(healthy)' || true")
      ;;
  esac

  if [[ -z "${healthy}" ]]; then
    ok "Todos os containers estao healthy"
  else
    warn "Alguns containers ainda nao estao healthy:"
    echo "${healthy}"
  fi
}

# ── Smoke ─────────────────────────────────────────────────────────────────────
smoke_test() {
  if [[ "$SKIP_SMOKE" == "true" ]]; then
    warn "Smoke tests pulados (--skip-smoke)"
    return 0
  fi

  step "Smoke tests..."

  local smoke_fail=0

  # Health check via API publica
  if curl -fsS -o /dev/null "https://${REMOTE_HOST}/observe/api/health" 2>/dev/null; then
    ok "API health OK"
  else
    # Tenta HTTP se HTTPS falhar
    if curl -fsS -o /dev/null "http://${REMOTE_HOST}:3080/observe/api/health" 2>/dev/null; then
      ok "API health OK (HTTP)"
    else
      warn "API health falhou"
      smoke_fail=1
    fi
  fi

  # Discovery audit endpoint (verifica se rota responde, mesmo que exija auth)
  local audit_status
  audit_status=$(curl -sS -o /dev/null -w '%{http_code}' "https://${REMOTE_HOST}/observe/api/discovery/audit" 2>/dev/null || echo "000")
  if [[ "${audit_status}" == "401" || "${audit_status}" == "200" ]]; then
    ok "Discovery audit endpoint respondeu (HTTP ${audit_status})"
  else
    audit_status=$(curl -sS -o /dev/null -w '%{http_code}' "http://${REMOTE_HOST}:3080/observe/api/discovery/audit" 2>/dev/null || echo "000")
    if [[ "${audit_status}" == "401" || "${audit_status}" == "200" ]]; then
      ok "Discovery audit endpoint respondeu (HTTP ${audit_status})"
    else
      warn "Discovery audit endpoint falhou (HTTP ${audit_status})"
      smoke_fail=1
    fi
  fi

  # Health interno dos containers
  if run_ssh_silent "docker exec r-observe-api wget -qO- http://127.0.0.1:3000/observe/api/health | grep -q '\"status\":\"ok\"'"; then
    ok "API container health OK"
  else
    warn "API container health falhou"
    smoke_fail=1
  fi

  if run_ssh_silent "docker exec r-observe-discovery wget -qO- http://127.0.0.1:3010/health | grep -q '\"status\":\"ok\"'"; then
    ok "Discovery container health OK"
  else
    warn "Discovery container health falhou"
    smoke_fail=1
  fi

  if [[ "${smoke_fail}" -ne 0 ]]; then
    warn "Smoke tests concluidos com alertas"
    return 1
  else
    ok "Smoke tests concluidos sem falhas"
    return 0
  fi
}

# ── Release tracking ──────────────────────────────────────────────────────────
track_release() {
  local release_ts
  release_ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local current_sha
  current_sha="$(git rev-parse --short HEAD 2>/dev/null || echo 'sem-git')"

  step "Registrando release ${release_ts}..."

  run_ssh "mkdir -p ${REMOTE_DIR}/releases && echo '${release_ts} | host=${REMOTE_HOST} | service=${SERVICE} | sha=${current_sha}' > ${REMOTE_DIR}/releases/latest.txt"

  ok "Release registrada"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo -e "${BOLD}── R-Observe Deploy Remoto ── target: ${REMOTE_HOST} | service: ${SERVICE} ──${RESET}"

  pre_check
  ensure_vpn
  sync_code
  build_on_remote
  restart_services
  smoke_test || true
  track_release

  echo -e "\n${BOLD}${GREEN}✅ Deploy concluido!${RESET}"
  echo ""
  echo "Endpoints:"
  echo "  API:       https://${REMOTE_HOST}/observe/api/health"
  echo "  Discovery: https://${REMOTE_HOST}/observe/discovery"
  echo "  Audit:     https://${REMOTE_HOST}/observe/api/discovery/audit"
  echo ""
}

main "$@"
