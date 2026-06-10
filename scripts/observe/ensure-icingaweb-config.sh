#!/usr/bin/env bash
# Ensure IcingaWeb2 writable command transport and module config are present.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env.observe}"

[[ -f "${ENV_FILE}" ]] || { echo "ERRO: .env.observe não encontrado em ${ENV_FILE}" >&2; exit 1; }

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

ICINGA_API_USER="${ICINGA_API_USER:-icingaweb2}"
ICINGA_API_PASSWORD="${ICINGA_API_PASSWORD:-}"

[[ -n "${ICINGA_API_PASSWORD}" ]] || { echo "ERRO: ICINGA_API_PASSWORD não definido" >&2; exit 1; }

docker exec \
  -e ICINGA_API_USER="${ICINGA_API_USER}" \
  -e ICINGA_API_PASSWORD="${ICINGA_API_PASSWORD}" \
  r-observe-icingaweb2 \
  sh -eu -c '
    mkdir -p /data/etc/icingaweb2/modules/icingadb

    cat > /tmp/icingadb-commandtransports.ini <<EOF
[r-observe-icinga2]
transport = api
host = r-observe-icinga2
port = 5665
username = ${ICINGA_API_USER}
password = ${ICINGA_API_PASSWORD}
EOF

    cat > /tmp/icingadb-config.ini <<EOF
[icingadb]
resource = icingadb

[redis1]
host = icinga-redis
port = 6379
EOF

    changed=0
    if ! cmp -s /tmp/icingadb-commandtransports.ini /data/etc/icingaweb2/modules/icingadb/commandtransports.ini 2>/dev/null; then
      cp /tmp/icingadb-commandtransports.ini /data/etc/icingaweb2/modules/icingadb/commandtransports.ini
      changed=1
    fi
    if ! cmp -s /tmp/icingadb-config.ini /data/etc/icingaweb2/modules/icingadb/config.ini 2>/dev/null; then
      cp /tmp/icingadb-config.ini /data/etc/icingaweb2/modules/icingadb/config.ini
      changed=1
    fi
    chown -R www-data:www-data /data/etc/icingaweb2/modules/icingadb 2>/dev/null || true
    if [ "$changed" -eq 1 ]; then
      echo changed
    else
      echo unchanged
    fi
  '
