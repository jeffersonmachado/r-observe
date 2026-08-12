#!/usr/bin/env bash
# ─── R-Observe Enterprise — Upgrade ──────────────────────────────────────────
# Uso: sudo bash upgrade.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*"; }

# ─── Verificações ────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
  error "Execute como root (ou com sudo)"
  exit 1
fi

cd "$PROJECT_DIR"

ENV_FILE="${1:-.env.observe}"
if [[ ! -f "$ENV_FILE" ]]; then
  error ".env.observe não encontrado. Execute install.sh primeiro."
  exit 1
fi

COMPOSE_FILE="docker-compose.observe.yml"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  R-Observe Enterprise — Upgrade"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── Backup pre-upgrade ──────────────────────────────────────────────────────
info "Executando backup pre-upgrade..."
bash "$SCRIPT_DIR/backup.sh" --pre-upgrade || warn "Backup pre-upgrade falhou (não-fatal)"

# ─── Chaves M2M por emissor ─────────────────────────────────────────────────
# Idempotente: cria apenas pares ausentes e nunca sobrescreve chaves existentes.
info "Validando keyring JWT por serviço..."
JWT_KEY_DIR="$PROJECT_DIR/secrets" bash "$PROJECT_DIR/scripts/observe/jwt-keys.sh" init

# ─── Pull new images ─────────────────────────────────────────────────────────
if ! grep -q '^OBSERVE_DB_APP_PASSWORD=' "$ENV_FILE"; then
  DB_APP_PASSWORD=$(openssl rand -base64 24 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
  {
    echo ""
    echo "OBSERVE_DB_APP_USER=observe_app"
    echo "OBSERVE_DB_APP_PASSWORD=$DB_APP_PASSWORD"
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "Credenciais da role runtime adicionadas ao ambiente legado"
fi

if ! grep -q '^OBSERVE_DB_EXPORTER_PASSWORD=' "$ENV_FILE"; then
  DB_EXPORTER_PASSWORD=$(openssl rand -base64 24 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
  {
    echo "OBSERVE_DB_EXPORTER_USER=observe_exporter"
    echo "OBSERVE_DB_EXPORTER_PASSWORD=$DB_EXPORTER_PASSWORD"
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "Credenciais da role de métricas adicionadas ao ambiente legado"
fi

info "Baixando novas imagens..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull 2>&1 || warn "Pull de imagens com warnings"

# ─── Build local services ────────────────────────────────────────────────────
info "Build dos serviços locais..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build 2>&1 || {
  error "Build falhou. Verifique os logs."
  exit 1
}

# ─── Restart services ────────────────────────────────────────────────────────
info "Reiniciando serviços..."

ACTIVE_PROFILES=""
for profile in observe-core observe-ai observe-agent observe-monitoring observe-icinga r-observe-proxy; do
  if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile "$profile" ps -q 2>/dev/null | grep -q .; then
    ACTIVE_PROFILES="$ACTIVE_PROFILES --profile $profile"
  fi
done

if [[ -z "$ACTIVE_PROFILES" ]]; then
  error "Nenhum serviço ativo encontrado."
  exit 1
fi

info "Profiles ativos:$ACTIVE_PROFILES"

COMPOSE_PARALLEL_LIMIT=1 docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" $ACTIVE_PROFILES up -d --remove-orphans 2>&1

# ─── Cleanup ──────────────────────────────────────────────────────────────────
info "Limpando imagens antigas..."
docker image prune -f 2>/dev/null || true

echo ""
info "Upgrade concluído!"
echo "  Verifique os logs: docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f --tail=50"
