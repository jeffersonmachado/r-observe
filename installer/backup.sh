#!/usr/bin/env bash
# ─── R-Observe Enterprise — Backup ──────────────────────────────────────────
# Uso: sudo bash backup.sh [--pre-upgrade] [--output DIR]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*"; }

PRE_UPGRADE=false
BACKUP_DIR="${2:-/opt/results/r-observe/backups}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pre-upgrade) PRE_UPGRADE=true; shift ;;
    --output) BACKUP_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
BACKUP_NAME="r-observe-backup-${TIMESTAMP}"
if [[ "$PRE_UPGRADE" == "true" ]]; then
  BACKUP_NAME="r-observe-pre-upgrade-${TIMESTAMP}"
fi

BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
mkdir -p "$BACKUP_PATH"

info "Iniciando backup: $BACKUP_NAME"

# ─── DB dump ──────────────────────────────────────────────────────────────────
info "Dump do PostgreSQL..."
if docker exec r-observe-postgres pg_dump -U observe observedb > "$BACKUP_PATH/database.sql" 2>/dev/null; then
  info "  database.sql: $(wc -c < "$BACKUP_PATH/database.sql") bytes"
else
  warn "  pg_dump falhou — container pode não estar rodando"
fi

# ─── Configs ──────────────────────────────────────────────────────────────────
info "Backup de configurações..."
if [[ -f "$PROJECT_DIR/.env.observe" ]]; then
  cp "$PROJECT_DIR/.env.observe" "$BACKUP_PATH/.env.observe"
  info "  .env.observe copiado"
fi
if [[ -d "$PROJECT_DIR/secrets" ]]; then
  cp -a "$PROJECT_DIR/secrets" "$BACKUP_PATH/secrets"
  chmod -R go-rwx "$BACKUP_PATH/secrets"
  info "  keyring JWT copiado"
fi

# ─── Docker volumes ───────────────────────────────────────────────────────────
info "Backup de volumes Docker..."
for vol in r-observe-postgres-data r-observe-redis-data; do
  if docker volume inspect "$vol" &>/dev/null; then
    warn "  Volume '$vol' detectado. Backup completo requer parada dos serviços."
    warn "  Para backup completo: pare os serviços e copie o volume."
  fi
done

# ─── Compress ─────────────────────────────────────────────────────────────────
info "Compactando..."
ARCHIVE="${BACKUP_PATH}.tar.gz"
tar -czf "$ARCHIVE" -C "$BACKUP_DIR" "$BACKUP_NAME" 2>/dev/null
rm -rf "$BACKUP_PATH"

info "Backup concluído: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Backup: $ARCHIVE"
echo ""
echo "  Para restaurar:"
echo "    sudo bash $SCRIPT_DIR/restore.sh $ARCHIVE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
