#!/bin/sh
# Entrypoint do worker em produção: sobe um Xvfb (display virtual) e exec o node.
#
# Por que não xvfb-run: o xvfb-run usa `wait` + SIGUSR1 para detectar o Xvfb
# pronto, e esse mecanismo trava quando o script é o PID 1 do container (o
# node nunca é lançado — verificado em prod, ago/2026). Aqui o Xvfb é filho
# direto, aguardamos o socket do display e o `exec` entrega o PID 1 ao node
# (sinais de docker stop chegam ao processo certo).
#
# Display virtual existe para o Chrome do canal WhatsApp QR rodar com
# WHATSAPP_QR_HEADLESS=false — desde ago/2026 a Meta derruba sessões wwebjs
# headless ~1-2 min após o pareamento (issue whatsapp-web.js #201894).
set -e

XVFB_DISPLAY="${XVFB_DISPLAY:-:99}"

Xvfb "$XVFB_DISPLAY" -screen 0 1920x1080x24 -nolisten tcp &

# Aguarda o socket do display (máx ~10s).
i=0
while [ ! -S "/tmp/.X11-unix/X${XVFB_DISPLAY#:}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "entrypoint: Xvfb não subiu em $XVFB_DISPLAY" >&2
    exit 1
  fi
  sleep 0.1
done

export DISPLAY="$XVFB_DISPLAY"
exec node --require ./src/tracing.js src/index.js
