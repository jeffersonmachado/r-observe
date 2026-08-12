#!/usr/bin/env bash
# ─── R-Observe Enterprise — Restore ─────────────────────────────────────────
# Uso: sudo bash restore.sh <backup.tar.gz>
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*"; }

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  error "Uso: sudo bash restore.sh <backup.tar.gz>"
  echo "  Backups disponíveis:"
  ls -lh /opt/results/r-observe/backups/*.tar.gz 2>/dev/null || echo "  (nenhum encontrado)"
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ATENÇÃO: Isso vai sobrescrever os dados atuais!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -rp "  Digite 'RESTAURAR' para confirmar: " CONFIRM
if [[ "$CONFIRM" != "RESTAURAR" ]]; then
  warn "Restauração cancelada."
  exit 0
fi

RESTORE_DIR="/tmp/r-observe-restore-$$"
mkdir -p "$RESTORE_DIR"

info "Extraindo backup..."
tar -xzf "$BACKUP_FILE" -C "$RESTORE_DIR"

BACKUP_CONTENT=$(find "$RESTORE_DIR" -maxdepth 2 -name "database.sql" -print -quit)
if [[ -z "$BACKUP_CONTENT" ]]; then
  error "Backup não contém database.sql"
  rm -rf "$RESTORE_DIR"
  exit 1
fi

BACKUP_NAME=$(basename "$(dirname "$(dirname "$BACKUP_CONTENT")")")
info "Backup: $BACKUP_NAME"

# ─── Restore DB ───────────────────────────────────────────────────────────────
info "Restaurando banco de dados..."
if docker exec -i r-observe-postgres psql -U observe observedb < "$BACKUP_CONTENT" 2>/dev/null; then
  info "Banco restaurado com sucesso"
else
  error "Falha ao restaurar banco"
  rm -rf "$RESTORE_DIR"
  exit 1
fi

# ─── Restore env ─────────────────────────────────────────────────────────────
ENV_BACKUP=$(find "$RESTORE_DIR" -name ".env.observe" -print -quit)
if [[ -n "$ENV_BACKUP" ]]; then
  info "Restaurando .env.observe..."
  cp "$ENV_BACKUP" "$PROJECT_DIR/.env.observe.restored"
  info "  Arquivo restaurado como .env.observe.restored"
  warn "  Compare com .env.observe atual e atualize manualmente se necessário"
fi

# ─── Restore keyring (sem sobrescrever automaticamente credenciais ativas) ───
KEYRING_BACKUP=$(find "$RESTORE_DIR" -type d -name secrets -print -quit)
if [[ -n "$KEYRING_BACKUP" ]]; then
  RESTORED_KEYS="$PROJECT_DIR/secrets.restored.$(date -u +%Y%m%d%H%M%S)"
  cp -a "$KEYRING_BACKUP" "$RESTORED_KEYS"
  chmod -R go-rwx "$RESTORED_KEYS"
  info "Keyring restaurado em $RESTORED_KEYS"
  warn "Compare e ative o keyring manualmente para evitar invalidar tokens em uso"
fi

rm -rf "$RESTORE_DIR"
info "Restauração concluída!"
