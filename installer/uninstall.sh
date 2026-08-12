#!/usr/bin/env bash
# ─── R-Observe Enterprise — Uninstall ────────────────────────────────────────
# Uso: sudo bash uninstall.sh [--purge]
#   --purge  Remove também volumes de dados (IRREVERSÍVEL)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*"; }

PURGE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=true; shift ;;
    *) shift ;;
  esac
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ATENÇÃO: Isso vai remover o R-Observe!"
if [[ "$PURGE" == "true" ]]; then
  echo "  MODO PURGE: Todos os dados serão PERMANENTEMENTE removidos!"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -rp "  Digite 'REMOVER' para confirmar: " CONFIRM
if [[ "$CONFIRM" != "REMOVER" ]]; then
  warn "Remoção cancelada."
  exit 0
fi

cd "$PROJECT_DIR"

ENV_FILE=".env.observe"
if [[ ! -f "$ENV_FILE" ]]; then
  ENV_FILE=""
fi

COMPOSE_FILE="docker-compose.observe.yml"

info "Parando containers..."
if [[ -n "$ENV_FILE" ]]; then
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down --remove-orphans 2>/dev/null || true
else
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
fi

if [[ "$PURGE" == "true" ]]; then
  warn "Removendo volumes de dados..."
  docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
  
  info "Removendo dados em /opt/results/r-observe/data..."
  rm -rf /opt/results/r-observe/data 2>/dev/null || true
fi

info "Removendo imagens..."
docker images | grep 'r-observe' | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true

info "R-Observe removido."
if [[ "$PURGE" != "true" ]]; then
  echo "  Volumes de dados preservados. Use --purge para remover tudo."
fi
