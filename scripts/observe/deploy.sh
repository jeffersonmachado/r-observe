#!/usr/bin/env bash
# ─── deploy.sh ────────────────────────────────────────────────────────────────
# Deploy completo da stack R-Observe num servidor remoto ou local.
#
# Uso:
#   ./scripts/observe/deploy.sh                  # deploy local
#   ./scripts/observe/deploy.sh --host 10.10.2.30 # deploy remoto via SSH
#   ./scripts/observe/deploy.sh --skip-discover  # sem varredura de hosts
#   ./scripts/observe/deploy.sh --skip-smoke     # sem smoke tests
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REMOTE_HOST=""
SKIP_DISCOVER=false
SKIP_SMOKE=false
SUBNET="${DEPLOY_SUBNET:-}"
SSH_PASSWORD="${SSH_PASSWORD:-${DEPLOY_SSH_PASSWORD:-}}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

step() { echo -e "\n${BOLD}${CYAN}▶ $*${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
die()  { echo -e "${RED}ERRO:${RESET} $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)          REMOTE_HOST="$2";    shift 2 ;;
    --subnet)        SUBNET="$2";         shift 2 ;;
    --skip-discover) SKIP_DISCOVER=true;  shift   ;;
    --skip-smoke)    SKIP_SMOKE=true;     shift   ;;
    --help|-h) grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# *//'; exit 0 ;;
    *) die "Argumento desconhecido: $1" ;;
  esac
done

# ── Decide se executa local ou via SSH ────────────────────────────────────────
if [[ -n "${REMOTE_HOST}" ]]; then
  if [[ -n "${SSH_PASSWORD}" ]]; then
    command -v sshpass >/dev/null 2>&1 || die "sshpass nao encontrado. Instale ou configure chave SSH para deploy remoto."
    run() { sshpass -p "${SSH_PASSWORD}" ssh -o StrictHostKeyChecking=no "root@${REMOTE_HOST}" "cd /opt/results/infra && $*"; }
    rsync_remote() {
      sshpass -p "${SSH_PASSWORD}" rsync -az --delete \
        --exclude='.env*' \
        --exclude='node_modules' \
        --exclude='.git' \
        -e "ssh -o StrictHostKeyChecking=no" \
        "${REPO_ROOT}/" "root@${REMOTE_HOST}:/opt/results/infra/"
    }
  else
    run() { ssh -o StrictHostKeyChecking=no "root@${REMOTE_HOST}" "cd /opt/results/infra && $*"; }
    rsync_remote() {
      rsync -az --delete \
        --exclude='.env*' \
        --exclude='node_modules' \
        --exclude='.git' \
        "${REPO_ROOT}/" "root@${REMOTE_HOST}:/opt/results/infra/"
    }
  fi
  run_local() { "$@"; }
  DEPLOY_TARGET="${REMOTE_HOST}"
  step "Sincronizando repositório em ${REMOTE_HOST}..."
  rsync_remote
  ok "Repositório sincronizado"
else
  run() { (cd "${REPO_ROOT}" && eval "$*"); }
  run_local() { "$@"; }
  DEPLOY_TARGET="local"
fi

echo -e "${BOLD}── R-Observe Deploy ── target: ${DEPLOY_TARGET} ──────────────────${RESET}"

# ── Pré-condições ─────────────────────────────────────────────────────────────
step "Verificando pré-condições..."

# .env.observe obrigatório
if ! run "test -f .env.observe"; then
  warn ".env.observe não encontrado."
  if [[ -n "${REMOTE_HOST}" ]]; then
    die "Crie .env.observe no servidor a partir de .env.observe.example antes de continuar."
  else
    die "Execute: cp .env.observe.example .env.observe && edite as senhas."
  fi
fi
ok ".env.observe presente"

# docker e docker compose disponíveis
run "docker compose version >/dev/null 2>&1" || die "docker compose não encontrado no target."
ok "docker compose disponível"

# ── Build das imagens ─────────────────────────────────────────────────────────
step "Construindo imagens customizadas..."
run "docker compose -f docker-compose.observe.yml --env-file .env.observe build \
  --parallel 2>&1 | tail -5"
ok "Build concluído"

# ── Subida da stack ───────────────────────────────────────────────────────────
step "Iniciando stack (todos os profiles)..."
run "docker compose -f docker-compose.observe.yml --env-file .env.observe \
  --profile observe-core \
  --profile observe-ai \
  --profile observe-agent \
  --profile observe-monitoring \
  --profile observe-icinga \
  --profile r-observe-proxy \
  up -d --remove-orphans 2>&1 | tail -10"
ok "Stack iniciada"

# ── Aguarda serviços ficarem healthy ─────────────────────────────────────────
step "Aguardando serviços ficarem healthy (máx 3min)..."
DEADLINE=$(( $(date +%s) + 180 ))
SERVICES="r-observe-postgres r-observe-redis r-observe-api r-observe-worker r-observe-icinga2"
ALL_OK=false
while [[ $(date +%s) -lt ${DEADLINE} ]]; do
  ALL_OK=true
  for svc in ${SERVICES}; do
    STATUS=$(run "docker inspect --format='{{.State.Health.Status}}' ${svc} 2>/dev/null || echo missing")
    if [[ "${STATUS}" != "healthy" ]]; then
      ALL_OK=false
      break
    fi
  done
  ${ALL_OK} && break
  echo -n "."
  sleep 10
done
echo ""
if ${ALL_OK}; then
  ok "Todos os serviços healthy"
else
  warn "Alguns serviços ainda não estão healthy. Verifique com: docker ps"
  run "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep observe" || true
fi

# ── Garante usuário admin do IcingaWeb2 ───────────────────────────────────────
step "Garantindo usuário admin do IcingaWeb2..."
run "bash scripts/observe/ensure-icingaweb-admin.sh" && \
  ok "Admin IcingaWeb2 sincronizado com .env.observe" || \
  warn "Não foi possível sincronizar admin IcingaWeb2"

step "Garantindo configuração writable do IcingaWeb2..."
ICINGAWEB_CONFIG_STATUS="$(run "bash scripts/observe/ensure-icingaweb-config.sh" || true)"
if [[ "${ICINGAWEB_CONFIG_STATUS}" == *"changed"* ]]; then
  run "docker restart r-observe-icingaweb2 >/dev/null"
  ok "Command Transport do IcingaDB configurado e IcingaWeb2 reiniciado"
elif [[ "${ICINGAWEB_CONFIG_STATUS}" == *"unchanged"* ]]; then
  ok "Command Transport do IcingaDB já estava configurado"
else
  warn "Não foi possível garantir Command Transport do IcingaDB"
fi

# ── Descoberta de hosts ───────────────────────────────────────────────────────
if [[ "${SKIP_DISCOVER}" == "false" ]]; then
  step "Descoberta automática de hosts..."
  DISCOVER_ARGS=""
  [[ -n "${SUBNET}" ]] && DISCOVER_ARGS="--subnet ${SUBNET}"

  if [[ -n "${REMOTE_HOST}" ]]; then
    run "bash scripts/observe/discover-hosts.sh ${DISCOVER_ARGS}" || \
      warn "Descoberta falhou — execute manualmente: npm run observe:discover"
  else
    bash "${SCRIPT_DIR}/discover-hosts.sh" ${DISCOVER_ARGS} || \
      warn "Descoberta falhou — execute manualmente: npm run observe:discover"
  fi
fi

# ── Smoke tests ───────────────────────────────────────────────────────────────
if [[ "${SKIP_SMOKE}" == "false" ]]; then
  step "Executando smoke tests..."
  if [[ -n "${REMOTE_HOST}" ]]; then
    run "bash scripts/observe/smoke-observe-stack.sh" && \
      ok "Smoke test geral passou" || warn "Smoke test geral falhou"
    run "bash scripts/observe/smoke-icinga.sh" && \
      ok "Smoke test Icinga passou" || warn "Smoke test Icinga falhou"
  else
    bash "${SCRIPT_DIR}/smoke-observe-stack.sh" && ok "Smoke test geral passou" || warn "Smoke test geral falhou"
    bash "${SCRIPT_DIR}/smoke-icinga.sh"        && ok "Smoke test Icinga passou" || warn "Smoke test Icinga falhou"
  fi
fi

# ── Resumo ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}─────────────────────────────────────────────────────────────${RESET}"
echo -e "${GREEN}${BOLD}Deploy concluído!${RESET}"

HTTP_PORT=$(run "grep OBSERVE_HTTP_PORT .env.observe 2>/dev/null | cut -d= -f2" 2>/dev/null || echo "3080")
TARGET_IP="${REMOTE_HOST:-localhost}"

echo ""
echo -e "  ${CYAN}Painel R-Observe:${RESET}  http://${TARGET_IP}:${HTTP_PORT}/observe/api/health"
echo -e "  ${CYAN}IcingaWeb2:${RESET}        http://${TARGET_IP}:${HTTP_PORT}/icinga/"
echo -e "  ${CYAN}Grafana:${RESET}           http://${TARGET_IP}:${HTTP_PORT}/grafana/"
echo ""
echo -e "  Logs:    docker compose -f docker-compose.observe.yml logs -f --tail=50"
echo -e "  Status:  docker compose -f docker-compose.observe.yml ps"
