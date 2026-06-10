#!/usr/bin/env bash
# Ensure the IcingaWeb2 admin user matches .env.observe.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

[[ -f "${ENV_FILE}" ]] || { echo "ERRO: .env.observe não encontrado em ${ENV_FILE}" >&2; exit 1; }

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

ICINGAWEB_ADMIN_USER="${ICINGAWEB_ADMIN_USER:-admin}"
ICINGAWEB_ADMIN_PASS="${ICINGAWEB_ADMIN_PASS:-}"
OBSERVE_DB_NAME="${OBSERVE_DB_NAME:-observedb}"
OBSERVE_DB_USER="${OBSERVE_DB_USER:-observe}"

[[ -n "${ICINGAWEB_ADMIN_PASS}" ]] || { echo "ERRO: ICINGAWEB_ADMIN_PASS não definido" >&2; exit 1; }

HASH="$(
  docker exec \
    -e ICINGAWEB_ADMIN_PASS="${ICINGAWEB_ADMIN_PASS}" \
    r-observe-icingaweb2 \
    php -r 'echo password_hash(getenv("ICINGAWEB_ADMIN_PASS"), PASSWORD_DEFAULT);'
)"

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

ADMIN_SQL="$(sql_escape "${ICINGAWEB_ADMIN_USER}")"
HASH_SQL="$(sql_escape "${HASH}")"

docker exec r-observe-postgres psql \
  -U "${OBSERVE_DB_USER}" \
  -d "${OBSERVE_DB_NAME}" \
  -v ON_ERROR_STOP=1 \
  -c "INSERT INTO icingaweb_user (name, active, password_hash, ctime, mtime)
      VALUES ('${ADMIN_SQL}', 1, convert_to('${HASH_SQL}', 'UTF8'), NOW(), NOW())
      ON CONFLICT (name) DO UPDATE
      SET active = 1,
          password_hash = EXCLUDED.password_hash,
          mtime = NOW();" >/dev/null

echo "IcingaWeb2 admin '${ICINGAWEB_ADMIN_USER}' garantido."
