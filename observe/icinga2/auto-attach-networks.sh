#!/bin/bash
# ─── Auto-attach Docker Networks ──────────────────────────────────────────
# Conecta o container Icinga2 a todas as redes Docker do host
# para que check_ping e outros checks alcancem containers em qualquer rede.
#
# Executado pelo entrypoint do Icinga2 antes de iniciar o daemon.
# ─────────────────────────────────────────────────────────────────────────
set -e

DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
SELF_ID=""

# Obtém ID do próprio container
if [ -f /proc/self/cgroup ]; then
    SELF_ID=$(grep -m1 "memory:/docker/" /proc/self/cgroup 2>/dev/null | sed 's|.*/docker/||' | cut -c1-64)
fi
if [ -z "$SELF_ID" ]; then
    SELF_ID=$(hostname)
fi

echo "[icinga-attach] Self container: ${SELF_ID}"

# Lista todas as redes Docker e conecta este container
NETWORKS=$(curl -s --unix-socket "${DOCKER_SOCK}" "http://localhost/networks" 2>/dev/null | \
    sed 's/},{/}\n{/g' | grep -o '"Name":"[^"]*"' | sed 's/"Name":"//;s/"//')

COUNT=0
for NET in $NETWORKS; do
    # Pula redes padrão que já estão no compose
    case "$NET" in
        host|none|infra_observe-internal|infra_observe-monitoring|infra_observe-egress|infra_observe-public) continue ;;
    esac

    # Conecta o container à rede
    curl -s --unix-socket "${DOCKER_SOCK}" -X POST \
        "http://localhost/networks/${NET}/connect" \
        -H "Content-Type: application/json" \
        -d "{\"Container\":\"${SELF_ID}\"}" >/dev/null 2>&1 && {
        COUNT=$((COUNT + 1))
        echo "[icinga-attach] Conectado a: ${NET}"
    }
done

echo "[icinga-attach] ${COUNT} rede(s) externa(s) conectada(s)"
