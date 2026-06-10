#!/bin/bash
set -e

CONF_DIR="/etc/icinga2/conf.d"
ENVSUBST_VARS='${ICINGA_API_USER} ${ICINGA_API_PASSWORD} ${ICINGA_REDIS_HOST} ${ICINGA_REDIS_PORT} ${TZ}'

for f in /observe-conf.d/*; do
  name=$(basename "${f}")
  case "${name}" in
    *.conf.tpl)
      dest="${CONF_DIR}/${name%.tpl}"
      envsubst "${ENVSUBST_VARS}" < "${f}" > "${dest}"
      echo "[observe-init] Gerado: ${dest}"
      ;;
    *.conf)
      cp -f "${f}" "${CONF_DIR}/${name}" 2>/dev/null || true
      echo "[observe-init] Copiado: ${CONF_DIR}/${name}"
      ;;
  esac
done

# Remove icingadb do features-enabled (usamos conf.d gerado via template)
rm -f /etc/icinga2/features-enabled/icingadb.conf 2>/dev/null || true

if [ -n "${ICINGA_ROOT_PASSWORD:-}" ]; then
  cat >> "${CONF_DIR}/api-users.conf" <<EOF

object ApiUser "root" {
  password = "${ICINGA_ROOT_PASSWORD}"
  permissions = ["*"]
}
EOF
fi

API_CONF="/etc/icinga2/features-enabled/api.conf"
if [ -f "${API_CONF}" ]; then
  sed -i 's/accept_config = false/accept_config = true/' "${API_CONF}"
  sed -i 's/accept_commands = false/accept_commands = true/' "${API_CONF}"
fi

icinga2 daemon -C

# Auto-attach em todas as redes Docker para alcançar containers cross-network
if [ -S /var/run/docker.sock ]; then
  /usr/local/bin/auto-attach-networks.sh || true
fi

exec icinga2 daemon
