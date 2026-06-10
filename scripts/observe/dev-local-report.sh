#!/bin/bash
# Script: dev-local-report.sh
# Objetivo: listar os serviços levantados pelo fluxo `npm run dev`

set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

declare -A SERVICES
SERVICES[3009]="API (r-observe api)"
SERVICES[3010]="Discovery (r-observe discovery)"
SERVICES[3011]="AI (r-observe ai)"
SERVICES[5177]="Frontend (Vite)"
SERVICES[5178]="Frontend fallback (Vite)"

echo "[dev-local-report] Verificando serviços dev nas portas: ${!SERVICES[*]}"

for port in "${!SERVICES[@]}"; do
  svc_name="${SERVICES[$port]}"
  # Tenta lsof primeiro, fallback para ss
  pid=""
  if command -v lsof &>/dev/null; then
    pid=$(lsof -ti :$port 2>/dev/null || true)
  else
    pid=$(ss -ltnp "( sport = :$port )" 2>/dev/null | awk '/LISTEN/ && $4 ~ /:'"$port"'$/ {print $NF}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' || true)
  fi

  if [ -n "$pid" ]; then
    cmdline="$(ps -p $pid -o args= 2>/dev/null || echo '')"
    echo "[dev-local-report] ✔ $svc_name -> porta $port (PID $pid) — $cmdline"
  else
    echo "[dev-local-report] ✖ $svc_name -> porta $port (não levantado)"
  fi
done

echo "[dev-local-report] Fim do relatório."
