#!/bin/bash
# Script: dev-local-reset-db.sh
# Objetivo: resetar o banco de dev local do r-observe de forma explícita
# Uso: CONFIRM_RESET=YES bash ./scripts/observe/dev-local-reset-db.sh

set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[dev-local-reset-db] ❌ Arquivo .env.observe não encontrado em $ENV_FILE"
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

if [ "${CONFIRM_RESET:-}" != "YES" ]; then
  echo "[dev-local-reset-db] ❌ Operação destrutiva bloqueada."
  echo "Execute: CONFIRM_RESET=YES npm run dev:reset-db"
  exit 1
fi

if ! command -v psql &>/dev/null; then
  echo "[dev-local-reset-db] ❌ psql não encontrado; instale o cliente PostgreSQL para continuar."
  exit 1
fi

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-${OBSERVE_DB_USER:-observe}}"
DB_NAME="${DB_NAME:-${OBSERVE_DB_NAME:-observedb}}"
DB_PASSWORD="${DB_PASSWORD:-${OBSERVE_DB_PASSWORD:-observe}}"

POSTGRES_PASSWORD="postgres"
if ! PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d postgres -c "SELECT 1;" &>/dev/null 2>&1; then
  POSTGRES_PASSWORD=""
  if ! PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d postgres -c "SELECT 1;" &>/dev/null 2>&1; then
    echo "[dev-local-reset-db] ❌ Não foi possível conectar como postgres. Verifique se o PostgreSQL está rodando localmente."
    exit 1
  fi
fi

echo "[dev-local-reset-db] ✔ Conectado como postgres. Resetando banco e usuário de dev..."

PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d postgres -v db_name="$DB_NAME" -v db_user="$DB_USER" -v db_pass="$DB_PASSWORD" <<'EOF'
SELECT pg_terminate_backend(pg_stat_activity.pid)
  FROM pg_stat_activity
 WHERE pg_stat_activity.datname = :'db_name'
   AND pid <> pg_backend_pid();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') THEN
    EXECUTE format('DROP DATABASE %I', :'db_name');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_user') THEN
    EXECUTE format('DROP ROLE %I', :'db_user');
  END IF;
  EXECUTE format('CREATE DATABASE %I', :'db_name');
  EXECUTE format('CREATE USER %I WITH PASSWORD %L', :'db_user', :'db_pass');
  EXECUTE format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'db_name', :'db_user');
END $$;
EOF

PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -d "$DB_NAME" -v db_user="$DB_USER" <<'EOF'
DO $$ BEGIN
  EXECUTE format('GRANT ALL PRIVILEGES ON SCHEMA public TO %I', :'db_user');
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', :'db_user');
  EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO %I', :'db_user');
END $$;
EOF

if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" &>/dev/null; then
  echo "[dev-local-reset-db] ✔ Reset do banco concluído."
else
  echo "[dev-local-reset-db] ❌ Falha ao validar o banco após reset."
  exit 1
fi