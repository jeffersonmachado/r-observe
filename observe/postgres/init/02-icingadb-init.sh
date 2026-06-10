#!/bin/bash
# ─── Cria banco e usuário do IcingaDB ────────────────────────────────────────
# Executado pelo PostgreSQL na primeira inicialização do container.
# Variáveis de ambiente injetadas pelo docker-compose.observe.yml:
#   ICINGADB_DB_NAME, ICINGADB_DB_USER, ICINGADB_DB_PASSWORD

set -e

# Só cria se as variáveis estiverem definidas
if [ -z "${ICINGADB_DB_NAME}" ] || [ -z "${ICINGADB_DB_USER}" ] || [ -z "${ICINGADB_DB_PASSWORD}" ]; then
    echo "[02-icingadb] ICINGADB_DB_* não definidos, pulando criação do banco IcingaDB."
    exit 0
fi

echo "[02-icingadb] Criando usuário e banco IcingaDB..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ICINGADB_DB_USER}') THEN
            CREATE USER ${ICINGADB_DB_USER} WITH ENCRYPTED PASSWORD '${ICINGADB_DB_PASSWORD}';
        END IF;
    END
    \$\$;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE ${ICINGADB_DB_NAME} OWNER ${ICINGADB_DB_USER}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${ICINGADB_DB_NAME}')
    \gexec
EOSQL

echo "[02-icingadb] Banco IcingaDB pronto."
