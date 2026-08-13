#!/usr/bin/env bash
# Deploy remoto do R-Observe por Docker save/load, sem registry e sem build remoto.
#
# Uso:
#   ./scripts/observe/deploy-local-images.sh
#   ./scripts/observe/deploy-local-images.sh --host 10.10.2.30 --user root
#   ./scripts/observe/deploy-local-images.sh --skip-build
#   ./scripts/observe/deploy-local-images.sh --skip-sync --skip-smoke
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT_DIR"

REMOTE_HOST="${DEPLOY_HOST:-10.10.2.30}"
REMOTE_USER="${DEPLOY_USER:-root}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/results/r-observe}"
SSH_PASSWORD="${SSH_PASSWORD:-${DEPLOY_SSH_PASSWORD:-}}"
COMPOSE_FILE="docker-compose.observe.yml"
ENV_FILE=".env.observe"
SKIP_BUILD=false
SKIP_SYNC=false
SKIP_SMOKE=false

PROFILES=(
  observe-core observe-ai observe-agent observe-monitoring observe-icinga r-observe-proxy
)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
step() { echo -e "\n${CYAN}=== $* ===${RESET}"; }
ok()   { echo -e "${GREEN}[OK]${RESET} $*"; }
warn() { echo -e "${YELLOW}[AVISO]${RESET} $*"; }
die()  { echo -e "${RED}[ERRO]${RESET} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Deploy remoto do R-Observe por Docker save/load, sem registry e sem build remoto.

Uso:
  ./scripts/observe/deploy-local-images.sh
  ./scripts/observe/deploy-local-images.sh --host 10.10.2.30 --user root
  ./scripts/observe/deploy-local-images.sh --skip-build
  ./scripts/observe/deploy-local-images.sh --skip-sync --skip-smoke
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) REMOTE_HOST="$2"; shift 2 ;;
    --user) REMOTE_USER="$2"; shift 2 ;;
    --dir) REMOTE_DIR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-sync) SKIP_SYNC=true; shift ;;
    --skip-smoke) SKIP_SMOKE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Argumento desconhecido: $1" ;;
  esac
done

SSH_OPTIONS=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=15
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)

ssh_base=(ssh "${SSH_OPTIONS[@]}")
if [[ -n "$SSH_PASSWORD" ]]; then
  command -v sshpass >/dev/null 2>&1 || die "sshpass e necessario quando SSH_PASSWORD esta definida"
  export SSHPASS="$SSH_PASSWORD"
  ssh_base=(sshpass -e ssh "${SSH_OPTIONS[@]}")
fi

run_ssh() {
  "${ssh_base[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

compose=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
for profile in "${PROFILES[@]}"; do
  compose+=(--profile "$profile")
done

preflight() {
  step "Preflight"
  for cmd in docker rsync gzip ssh; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd nao encontrado"
  done
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE nao encontrado"
  "${compose[@]}" config --quiet
  run_ssh "docker version >/dev/null && docker compose version >/dev/null"

  local local_arch remote_arch
  local_arch="$(uname -m)"
  remote_arch="$(run_ssh uname -m)"
  [[ "$local_arch" == "$remote_arch" ]] || die "Arquiteturas diferentes: local=$local_arch remoto=$remote_arch"
  ok "Compose valido; Docker remoto acessivel; arquitetura ${local_arch}"
}

build_local() {
  step "Build local das imagens"
  if [[ "$SKIP_BUILD" == true ]]; then
    warn "Build local pulado; serao usadas as imagens locais existentes"
  else
    "${compose[@]}" build
    ok "Build concluido no computador local"
  fi
}

resolve_images() {
  mapfile -t IMAGES < <("${compose[@]}" config --images | sort -u)
  [[ ${#IMAGES[@]} -gt 0 ]] || die "Compose nao retornou imagens"

  local missing=()
  local image
  for image in "${IMAGES[@]}"; do
    docker image inspect "$image" >/dev/null 2>&1 || missing+=("$image")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s\n' "${missing[@]}" >&2
    die "Imagens locais ausentes; execute novamente sem --skip-build"
  fi
  ok "${#IMAGES[@]} imagens locais prontas para transferencia"
}

resolve_outdated_images() {
  step "Comparacao das imagens local/remoto"
  OUTDATED_IMAGES=()

  local image local_id remote_id quoted_image
  for image in "${IMAGES[@]}"; do
    local_id="$(docker image inspect "$image" --format '{{.Id}}')"
    printf -v quoted_image '%q' "$image"
    remote_id="$(run_ssh "docker image inspect --format '{{.Id}}' ${quoted_image} 2>/dev/null || true")"

    if [[ -n "$remote_id" && "$remote_id" == "$local_id" ]]; then
      ok "Atual: $image"
    else
      OUTDATED_IMAGES+=("$image")
      if [[ -n "$remote_id" ]]; then
        warn "Desatualizada: $image"
      else
        warn "Ausente no remoto: $image"
      fi
    fi
  done

  if [[ ${#OUTDATED_IMAGES[@]} -eq 0 ]]; then
    ok "Servidor ja possui todas as imagens com o mesmo ID de conteudo"
  else
    ok "${#OUTDATED_IMAGES[@]} de ${#IMAGES[@]} imagens precisam ser transferidas"
  fi
}

sync_code() {
  step "Sincronizacao do codigo"
  if [[ "$SKIP_SYNC" == true ]]; then
    warn "Sincronizacao pulada"
    return
  fi

  run_ssh "mkdir -p '$REMOTE_DIR'"
  local remote_shell
  printf -v remote_shell '%q ' "${ssh_base[@]}"
  rsync -az --delete \
    --exclude='.env*' \
    --exclude='secrets' \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='backups' \
    --exclude='test-results' \
    --exclude='playwright-report' \
    --exclude='*.log' \
    -e "$remote_shell" \
    "$ROOT_DIR/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
  ok "Codigo sincronizado; ambiente e segredos remotos preservados"
}

transfer_images() {
  step "Transferencia Docker save/load"
  if [[ ${#OUTDATED_IMAGES[@]} -eq 0 ]]; then
    ok "Nenhuma imagem alterada; transferencia pulada"
    return
  fi

  local total_bytes
  total_bytes="$(docker image inspect "${OUTDATED_IMAGES[@]}" --format '{{.Size}}' | awk '{s+=$1} END {print s+0}')"
  ok "Transferindo ${#OUTDATED_IMAGES[@]} imagens alteradas (soma logica: $((total_bytes / 1024 / 1024)) MiB)"

  # Um unico stream evita arquivos tar temporarios e remove duplicacao de layers.
  docker save "${OUTDATED_IMAGES[@]}" | gzip -1 | run_ssh "gzip -dc | docker load"
  ok "Imagens alteradas carregadas no servidor"
}

deploy_remote() {
  step "Subida remota sem build"
  local profile_args=""
  local profile
  for profile in "${PROFILES[@]}"; do
    printf -v profile_args '%s --profile %q' "$profile_args" "$profile"
  done

  run_ssh "set -euo pipefail
    cd '$REMOTE_DIR'
    test -s '$ENV_FILE'
    test -s secrets/jwt_api_private.pem
    docker network inspect dns-consolidated_dns-internal >/dev/null
    docker network inspect infra-mail_default >/dev/null 2>&1 || docker network create infra-mail_default >/dev/null
    bash scripts/observe/compute-resource-limits.sh --write '$ENV_FILE'
    docker compose -f '$COMPOSE_FILE' --env-file '$ENV_FILE' $profile_args config --quiet
    docker compose -f '$COMPOSE_FILE' --env-file '$ENV_FILE' $profile_args up -d --no-build --pull never --remove-orphans
    bash scripts/observe/ensure-icingaweb-admin.sh
    docker compose -f '$COMPOSE_FILE' --env-file '$ENV_FILE' ps"
  ok "Stack iniciada com --no-build --pull never"
}

validate_remote() {
  step "Validacao remota"
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if run_ssh "cd '$REMOTE_DIR' && OBSERVE_HEALTH_BASE=http://127.0.0.1:3080 bash scripts/observe/healthcheck.sh"; then
      ok "Healthcheck remoto aprovado"
      break
    fi
    [[ "$attempt" -lt 6 ]] || die "Healthcheck remoto falhou apos 6 tentativas"
    warn "Servicos ainda inicializando (${attempt}/6); nova tentativa em 10s"
    sleep 10
  done

  if [[ "$SKIP_SMOKE" == true ]]; then
    warn "Smoke test pulado"
  else
    run_ssh "cd '$REMOTE_DIR' && bash scripts/observe/smoke-observe-stack.sh"
    ok "Smoke test geral aprovado"
    run_ssh "cd '$REMOTE_DIR' && bash scripts/observe/smoke-icinga.sh"
    ok "Smoke test Icinga aprovado"
  fi
}

step "Deploy R-Observe por imagens locais"
echo "Host: ${REMOTE_USER}@${REMOTE_HOST}"
echo "Diretorio: ${REMOTE_DIR}"
echo "Politica: build local -> docker save/load -> up --no-build --pull never"

preflight
build_local
resolve_images
resolve_outdated_images
sync_code
transfer_images
deploy_remote
validate_remote

step "Deploy concluido"
ok "R-Observe publicado sem qualquer build remoto"
