#!/bin/bash
# Para apenas dependências locais do dev híbrido. Não remove volumes.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

[[ -f "$ENV_FILE" ]] || { echo "[dev-local-down] FAIL: arquivo .env.observe não encontrado em $ENV_FILE" >&2; exit 1; }

echo "[dev-local-down] parando observe-postgres e observe-redis"
docker compose -f "$ROOT_DIR/docker-compose.observe.yml" --env-file "$ENV_FILE" --profile observe-core stop observe-postgres observe-redis
echo "[dev-local-down] dependências paradas; volumes preservados"
