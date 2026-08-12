#!/bin/bash
# Entrypoint wrapper: substitui variáveis de ambiente nos templates
# antes de iniciar o daemon Icinga2.
set -e

CONF_DIR="/etc/icinga2/conf.d"

# Substitui apenas variáveis de container conhecidas (ICINGA_*, TZ).
# Macros do Icinga2 no formato $macro_name$ ficam intactas.
ENVSUBST_VARS='${ICINGA_API_USER} ${ICINGA_API_PASSWORD} ${ICINGA_REDIS_HOST} ${ICINGA_REDIS_PORT} ${TZ}'

find "${CONF_DIR}" -name "*.conf.tpl" | while read -r tmpl; do
  out="${tmpl%.tpl}"
  envsubst "${ENVSUBST_VARS}" < "${tmpl}" > "${out}"
  echo "[observe-entrypoint] Gerado: ${out}"
done

# Valida a configuração antes de iniciar
icinga2 daemon -C
echo "[observe-entrypoint] Configuração validada. Iniciando daemon..."

# Chama o daemon Icinga2
exec /usr/sbin/icinga2 daemon "$@"
