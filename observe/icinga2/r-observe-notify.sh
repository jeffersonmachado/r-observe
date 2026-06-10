#!/bin/bash
# Envia um evento de notificação do Icinga2 para a R-Observe API.
# Chamado pelo NotificationCommand do Icinga2 com variáveis de ambiente definidas.
set -euo pipefail

: "${R_OBSERVE_URL:?R_OBSERVE_URL obrigatório}"
: "${R_OBSERVE_TOKEN:?R_OBSERVE_TOKEN obrigatório}"

# Mapeia estado/tipo Icinga para o tipo de evento do R-Observe
if [ -n "${SERVICE_NAME:-}" ]; then
  case "${SERVICE_STATE:-UNKNOWN}" in
    CRITICAL) EVENT_TYPE="service.critical" ;;
    WARNING)  EVENT_TYPE="service.warning"  ;;
    OK)       EVENT_TYPE="service.recovery" ;;
    *)        EVENT_TYPE="service.unknown"  ;;
  esac
  STATE="${SERVICE_STATE:-UNKNOWN}"
  OUTPUT="${SERVICE_OUTPUT:-}"
else
  case "${HOST_STATE:-UNKNOWN}" in
    DOWN)    EVENT_TYPE="host.down"     ;;
    UP)      EVENT_TYPE="host.recovery" ;;
    *)       EVENT_TYPE="host.unknown"  ;;
  esac
  STATE="${HOST_STATE:-UNKNOWN}"
  OUTPUT="${HOST_OUTPUT:-}"
fi

# Linha única, tamanho limitado, aspas escapadas — evita JSON malformado
SAFE_OUTPUT=$(printf '%s' "${OUTPUT}" | head -1 | tr -d '\n\r\t' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-256)

PAYLOAD=$(printf \
  '{"type":"%s","notification_type":"%s","host":"%s","address":"%s","service":"%s","state":"%s","output":"%s","source":"icinga"}' \
  "${EVENT_TYPE}" \
  "${NOTIFICATION_TYPE:-PROBLEM}" \
  "${HOST_NAME:-}" \
  "${HOST_ADDRESS:-}" \
  "${SERVICE_NAME:-}" \
  "${STATE}" \
  "${SAFE_OUTPUT}")

# Falha silenciosa: o Icinga2 não deve travar por erro na API R-Observe
curl -sf -o /dev/null \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-icinga-token: ${R_OBSERVE_TOKEN}" \
  --max-time 10 \
  --retry 2 \
  "${R_OBSERVE_URL}/observe/api/icinga/events" \
  --data "${PAYLOAD}" || true
