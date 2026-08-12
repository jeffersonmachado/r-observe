#!/usr/bin/env bash
# ─── R-Observe Enterprise — Validate ────────────────────────────────────────
# Uso: bash validate.sh
# Verifica se todos os pré-requisitos estão atendidos para instalação.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
PASS="${GREEN}✓${NC}"; WARN="${YELLOW}⚠${NC}"; FAIL="${RED}✗${NC}"

PASSES=0; WARNS=0; FAILS=0

check() {
  local label="$1"; shift
  if "$@" &>/dev/null; then
    printf "  ${PASS} %s\n" "$label"
    PASSES=$((PASSES + 1))
  else
    printf "  ${FAIL} %s\n" "$label"
    FAILS=$((FAILS + 1))
  fi
}

warn_check() {
  local label="$1"; shift
  if "$@" &>/dev/null; then
    printf "  ${PASS} %s\n" "$label"
    PASSES=$((PASSES + 1))
  else
    printf "  ${WARN} %s\n" "$label"
    WARNS=$((WARNS + 1))
  fi
}

version_at_least() {
  local minimum="$1" current="$2"
  [[ "$(printf '%s\n%s\n' "$minimum" "$current" | sort -V | head -n1)" == "$minimum" ]]
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  R-Observe Enterprise — Validação de Ambiente"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "Sistema Operacional:"
check "Linux" bash -c '[[ "$(uname -s)" == "Linux" ]]'
check "x86_64/amd64" bash -c '[[ "$(uname -m)" =~ ^(x86_64|amd64)$ ]]'

echo ""
echo "Docker:"
check "Docker instalado" command -v docker
DOCKER_VERSION="$(docker version --format '{{.Client.Version}}' 2>/dev/null || echo 0)"
warn_check "Docker >= 20.10 (${DOCKER_VERSION})" version_at_least 20.10 "$DOCKER_VERSION"
check "Docker rodando" docker info

echo ""
echo "Docker Compose:"
check "Docker Compose plugin" docker compose version

echo ""
echo "Recursos do Sistema:"
MEM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo "0")
CPU_CORES=$(nproc 2>/dev/null || echo "0")
warn_check "Memória >= 2048MB (${MEM_MB}MB)" bash -c "test $MEM_MB -ge 2048"
warn_check "CPU >= 2 cores (${CPU_CORES})" bash -c "test $CPU_CORES -ge 2"

echo ""
echo "Portas necessárias:"
for port in 3080 3000 3010 5432 6379 9090 3001 3100; do
  if ss -tlnp 2>/dev/null | grep -q ":$port " || netstat -tlnp 2>/dev/null | grep -q ":$port "; then
    printf "  ${WARN} Porta %s: EM USO\n" "$port"
    WARNS=$((WARNS + 1))
  else
    printf "  ${PASS} Porta %s: livre\n" "$port"
    PASSES=$((PASSES + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  Resultado: ${PASS} %d passaram  ${WARN} %d warnings  ${FAIL} %d falharam\n" "$PASSES" "$WARNS" "$FAILS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAILS -gt 0 ]]; then
  echo ""
  echo "  Corrija as falhas acima antes de executar install.sh"
  exit 1
fi

if [[ $WARNS -gt 0 ]]; then
  echo ""
  echo "  Warnings detectados. A instalação pode funcionar, mas não é o ideal."
fi

exit 0
