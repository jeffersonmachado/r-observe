#!/bin/bash
# ─── R-Observe Dev Quick Start ───────────────────────────────────────────────
# Sobe PostgreSQL + Redis + todos os serviços r-observe com hot reload.
# Edite os fontes em ./r-observe/*/src/ e o node --watch recarrega automaticamente.
#
# Pré-requisitos:
#   1. docker compose disponível
#   2. .env.observe configurado com senhas válidas
#   3. Imagens já buildadas (se não, use --build)
#
# Uso:
#   ./scripts/observe/dev-up.sh              # Sobe tudo
#   ./scripts/observe/dev-up.sh --build      # Força rebuild das imagens
#   ./scripts/observe/dev-up.sh --logs       # Sobe e já mostra logs
#   ./scripts/observe/dev-up.sh --down       # Derruba tudo
#   ./scripts/observe/dev-up.sh --restart    # Reinicia serviços (mantém infra)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.observe"

COMPOSE_FILES=(
  -f "${ROOT_DIR}/docker-compose.observe.yml"
  -f "${ROOT_DIR}/docker-compose.observe.dev.yml"
)

PROFILES=(--profile observe-core --profile observe-ai --profile observe-agent --profile observe-discovery)

DO_BUILD=false
DO_DOWN=false
DO_LOGS=false
DO_RESTART=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)   DO_BUILD=true; shift ;;
    --down)    DO_DOWN=true; shift ;;
    --logs)    DO_LOGS=true; shift ;;
    --restart) DO_RESTART=true; shift ;;
    *) shift ;;
  esac
done

cd "$ROOT_DIR"

[[ -f "$ENV_FILE" ]] || { echo "[dev-up] ERRO: .env.observe não encontrado em $ENV_FILE" >&2; exit 1; }

if [[ "$DO_DOWN" == "true" ]]; then
  echo "[dev-up] Derrubando todos os containers..."
  docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE" down
  echo "[dev-up] Pronto."
  exit 0
fi

if [[ "$DO_RESTART" == "true" ]]; then
  echo "[dev-up] Reiniciando serviços (sem rebuild)..."
  docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE" "${PROFILES[@]}" restart r-observe-api r-observe-discovery r-observe-worker r-observe-ai r-observe-agent
  echo "[dev-up] Serviços reiniciados."
  exit 0
fi

BUILD_ARG=""
if [[ "$DO_BUILD" == "true" ]]; then
  echo "[dev-up] Forçando rebuild das imagens..."
  BUILD_ARG="--build"
fi

# Etapa 1: Infra (PostgreSQL + Redis)
echo "[dev-up] Subindo infraestrutura (PostgreSQL + Redis)..."
docker compose -f "${ROOT_DIR}/docker-compose.observe.yml" --env-file "$ENV_FILE" --profile observe-core up -d r-observe-postgres r-observe-redis

# Aguarda health checks
echo "[dev-up] Aguardando PostgreSQL e Redis ficarem healthy..."
for _ in {1..60}; do
  PG=$(docker inspect -f '{{.State.Health.Status}}' r-observe-postgres 2>/dev/null || echo "none")
  RD=$(docker inspect -f '{{.State.Health.Status}}' r-observe-redis 2>/dev/null || echo "none")
  if [[ "$PG" == "healthy" && "$RD" == "healthy" ]]; then
    echo "[dev-up] PostgreSQL: $PG  Redis: $RD"
    break
  fi
  sleep 2
done

# Etapa 2: Serviços r-observe com hot reload
echo "[dev-up] Subindo serviços r-observe com hot reload (node --watch)..."
# shellcheck disable=SC2086
docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE" "${PROFILES[@]}" up -d $BUILD_ARG

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  R-Observe Dev Environment — Hot Reload Ativo"
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "  Serviços:"
echo "    API:        http://localhost:3009/observe/api/health"
echo "    Discovery:  http://localhost:3010/health"
echo "    AI:         http://localhost:3011/health"
echo "    Worker:     (background)"
echo "    Agent:      (background)"
echo ""
echo "  Hot reload: edite arquivos em ./r-observe/*/src/"
echo "              o node --watch recarrega em <1s"
echo ""
echo "  Logs:        docker compose -f docker-compose.observe.yml --env-file .env.observe logs -f r-observe-api"
echo "  Parar:       ./scripts/observe/dev-up.sh --down"
echo "  Reiniciar:   ./scripts/observe/dev-up.sh --restart"
echo "══════════════════════════════════════════════════════════════"

if [[ "$DO_LOGS" == "true" ]]; then
  echo ""
  echo "[dev-up] Mostrando logs (Ctrl+C para sair)..."
  docker compose -f "${ROOT_DIR}/docker-compose.observe.yml" --env-file "$ENV_FILE" logs -f --tail=20 r-observe-api r-observe-discovery r-observe-worker r-observe-ai
fi
