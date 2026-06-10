#!/bin/bash
# Script: smoke-dev.sh
# Objetivo: validação smoke para o dev local do r-observe

set -e

if ! command -v curl &>/dev/null; then
  echo "[smoke-dev] ❌ curl não encontrado. Instale curl para executar smoke tests."
  exit 1
fi

API_URL="${API_URL:-http://127.0.0.1:3009}"
DISCOVERY_URL="${DISCOVERY_URL:-http://127.0.0.1:3010}"
AI_URL="${AI_URL:-http://127.0.0.1:3011}"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:5177}"

check() {
  local name="$1"
  local url="$2"
  echo "[smoke-dev] Verificando $name em $url"
  if curl -sf --max-time 10 "$url" >/dev/null; then
    echo "[smoke-dev] ✔ $name disponível"
  else
    echo "[smoke-dev] ❌ Falha ao acessar $name em $url"
    exit 1
  fi
}

check_api() {
  local url="$1/observe/api/health"
  echo "[smoke-dev] Verificando API health em $url"
  if curl -sf --max-time 10 "$url" | grep -q '"status":"ok"'; then
    echo "[smoke-dev] ✔ API health OK"
  else
    echo "[smoke-dev] ❌ API health falhou em $url"
    exit 1
  fi
}

check_api "$API_URL"
check "Discovery UI" "$DISCOVERY_URL/observe/discovery"
check "Discovery health" "$DISCOVERY_URL/health"
check "Discovery proxy" "$API_URL/observe/discovery"
check "AI health" "$AI_URL/health"
check "Frontend assets" "$FRONTEND_URL/src/ui/main.js"

echo "[smoke-dev] ✔ Todos os checks de dev local passaram."