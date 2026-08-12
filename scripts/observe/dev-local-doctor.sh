#!/bin/bash
# Script: dev-local-doctor.sh
# Objetivo: validar o ambiente local de dev do r-observe

set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[dev-local-doctor] ❌ Arquivo .env.observe não encontrado em $ENV_FILE"
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

for service in api worker agent discovery automation; do
  for kind in private public; do
    if [ ! -f "$ROOT_DIR/secrets/jwt_${service}_${kind}.pem" ]; then
      echo "[dev-local-doctor] ❌ Keyring JWT incompleto; execute scripts/observe/jwt-keys.sh init"
      exit 1
    fi
  done
done

if [ -z "${OBSERVE_DB_PASSWORD:-}" ]; then
  echo "[dev-local-doctor] ❌ OBSERVE_DB_PASSWORD não definido em .env.observe"
  exit 1
fi

if ! command -v psql &>/dev/null; then
  echo "[dev-local-doctor] ❌ psql não encontrado; instale o cliente PostgreSQL para validar o ambiente."
  exit 1
fi

echo "[dev-local-doctor] ✔ .env.observe carregado"

bash "$ROOT_DIR/scripts/observe/dev-local-up.sh" --check-only

echo "[dev-local-doctor] ✔ Ambiente de dev corresponde aos pré-requisitos."
