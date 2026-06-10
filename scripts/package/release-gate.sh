#!/usr/bin/env bash
# scripts/package/release-gate.sh
#
# Orquestrador do Self-Proving Release Pipeline.
# Executa os 6 gates em sequência e gera relatório JSON.
#
# Gates em ordem:
#   1. dist:clean:release — limpeza obrigatória de artefatos para build determinístico
#   2. observe:validate   — configuração Docker Compose + variáveis de ambiente
#   3. discovery:gate     — gate obrigatório completo do Discovery Engine
#   4. zip                — empacotamento + validação automática de dist/infra.zip
#   5. zip:release        — empacotamento + validação de dist/infra-release.zip
#   6. release:validate:enterprise — validação hardened cruzada dos dois ZIPs
#   7. release:audit      — auditoria de artefato + 4 testes destrutivos auto-comprovantes
#   8. release:smoke      — extração em dir limpo + unit tests + sondagem de runtime
#
# Sai com exit 1 se qualquer gate falhar.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ "${RELEASE_LOCK_HELD:-0}" != "1" ]]; then
  RELEASE_LOCK_FILE="${RELEASE_LOCK_FILE:-/tmp/infra-release.lock}"
  exec 9>"$RELEASE_LOCK_FILE"
  if ! flock -n 9; then
    echo "[release:gate] erro: outro pipeline de release esta em execucao (lock: $RELEASE_LOCK_FILE)" >&2
    exit 1
  fi
  export RELEASE_LOCK_HELD=1
  export RELEASE_LOCK_FILE
fi

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

_section() { printf "\n${BOLD}%s${NC}\n" "$*"; }
_info()    { printf "${YELLOW}[GATE]${NC} %s\n" "$*"; }

mkdir -p dist
REPORT="dist/release-gate-report.json"
TIMING_LOG="dist/release-timing.log"
DATE_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DATE_START="$(date +%s)"

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
timelog() {
  local msg="$1"
  printf '%s | %s\n' "$(timestamp)" "$msg" | tee -a "$TIMING_LOG" >/dev/null
}

: > "$TIMING_LOG"
timelog "release:gate start workspace=${ROOT_DIR}"

# Arrays para rastrear resultados
declare -a GATE_NAMES=()
declare -a GATE_STATUS=()
declare -a GATE_DURATION=()

GATE_FAIL=0

# ─── Helper: executa um gate e rastreia resultado ────────────────────────────
run_gate() {
  local name="$1"
  shift
  local label="${name}"

  printf "\n${BOLD}${CYAN}┌─────────────────────────────────────────────────────────────────┐${NC}\n"
  printf "${BOLD}${CYAN}│  GATE: %-58s│${NC}\n" "$label"
  printf "${BOLD}${CYAN}└─────────────────────────────────────────────────────────────────┘${NC}\n"

  local t0
  t0="$(date +%s)"
  timelog "gate_start name=${name}"

  set +e
  "$@"
  local rc=$?
  set -e

  local t1
  t1="$(date +%s)"
  local elapsed=$(( t1 - t0 ))

  GATE_NAMES+=("$name")
  GATE_DURATION+=("$elapsed")

  if [[ "$rc" -eq 0 ]]; then
    GATE_STATUS+=("pass")
    printf "\n${GREEN}[GATE PASS]${NC} ${BOLD}%s${NC}  (%ds)\n" "$label" "$elapsed"
    timelog "gate_end name=${name} status=pass duration_s=${elapsed}"
  else
    GATE_STATUS+=("fail")
    printf "\n${RED}[GATE FAIL]${NC} ${BOLD}%s${NC}  (exit %d  %ds)\n" "$label" "$rc" "$elapsed"
    GATE_FAIL=1
    timelog "gate_end name=${name} status=fail exit=${rc} duration_s=${elapsed}"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# BANNER INICIAL
# ════════════════════════════════════════════════════════════════════════════
printf "\n${BOLD}╔══════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║         SELF-PROVING RELEASE PIPELINE — release:gate             ║${NC}\n"
printf "${BOLD}║   Única fonte de verdade para a integridade do release            ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}\n"
_info "Workspace: $ROOT_DIR"
_info "Iniciado: $DATE_UTC"
_info "8 gates serão executados em sequência"

# ════════════════════════════════════════════════════════════════════════════
# EXECUÇÃO DOS 8 GATES
# ════════════════════════════════════════════════════════════════════════════

# Gate 1: dist clean obrigatório
run_gate "dist:clean:release" npm run dist:clean:release

# Gate 2: observe:validate
run_gate "observe:validate" npm run observe:validate

# Gate 3: discovery:gate
run_gate "discovery:gate" npm run discovery:gate

# Gate 4: zip (infra.zip)
run_gate "zip" npm run zip

# Gate 5: zip:release (infra-release.zip)
run_gate "zip:release" npm run zip:release

# Gate 6: validação hardened cruzada
run_gate "release:validate:enterprise" npm run release:validate:enterprise

# Gate 7: release:audit (+ 4 testes destrutivos)
run_gate "release:audit" npm run release:audit

# Gate 8: release:smoke (extração + runtime probe)
run_gate "release:smoke" npm run release:smoke

# ════════════════════════════════════════════════════════════════════════════
# TABELA DE RESULTADOS
# ════════════════════════════════════════════════════════════════════════════
DATE_END="$(date +%s)"
TOTAL_ELAPSED=$(( DATE_END - DATE_START ))

printf "\n${BOLD}╔══════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║                   RESUMO DOS GATES                               ║${NC}\n"
printf "${BOLD}╠══════════════════════════════════════════════════════════════════╣${NC}\n"

PASS_GATES=0
FAIL_GATES=0
GATE_JSON_ENTRIES=""

for i in "${!GATE_NAMES[@]}"; do
  gname="${GATE_NAMES[$i]}"
  gstatus="${GATE_STATUS[$i]}"
  gdur="${GATE_DURATION[$i]}"

  if [[ "$gstatus" == "pass" ]]; then
    ICON="${GREEN}✓${NC}"
    PASS_GATES=$((PASS_GATES + 1))
    COLOR="$GREEN"
  else
    ICON="${RED}✗${NC}"
    FAIL_GATES=$((FAIL_GATES + 1))
    COLOR="$RED"
  fi

  printf "${BOLD}║${NC}  %b  ${COLOR}%-48s${NC}  %4ds  ${BOLD}║${NC}\n" \
    "$ICON" "$gname" "$gdur"

  GATE_JSON_ENTRIES="${GATE_JSON_ENTRIES}    {\"gate\":\"${gname}\",\"status\":\"${gstatus}\",\"duration_s\":${gdur}},"
done

# Remove trailing comma from last entry
GATE_JSON_ENTRIES="${GATE_JSON_ENTRIES%,}"

printf "${BOLD}╠══════════════════════════════════════════════════════════════════╣${NC}\n"
printf "${BOLD}║${NC}  PASS: %-3d  FAIL: %-3d  Tempo total: %-5ds                       ${BOLD}║${NC}\n" \
  "$PASS_GATES" "$FAIL_GATES" "$TOTAL_ELAPSED"
printf "${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}\n"

# ════════════════════════════════════════════════════════════════════════════
# RELATÓRIO JSON
# ════════════════════════════════════════════════════════════════════════════
ZIP_COUNT=0
ZIP_SIZE=""
if [[ -f "dist/infra.zip" ]]; then
  ZIP_COUNT="$(unzip -Z -1 dist/infra.zip | wc -l | tr -d ' ')"
  ZIP_SIZE="$(du -sh dist/infra.zip | cut -f1)"
fi

OVERALL_STATUS="$([ "$GATE_FAIL" -eq 0 ] && echo green || echo red)"

cat > "$REPORT" <<EOJSON
{
  "generated_at": "${DATE_UTC}",
  "status": "${OVERALL_STATUS}",
  "workspace": "${ROOT_DIR}",
  "duration_s": ${TOTAL_ELAPSED},
  "gates_pass": ${PASS_GATES},
  "gates_fail": ${FAIL_GATES},
  "gates": [
${GATE_JSON_ENTRIES}
  ],
  "artifacts": {
    "infra_zip": {
      "path": "dist/infra.zip",
      "exists": $([ -f "dist/infra.zip" ] && echo true || echo false),
      "file_count": ${ZIP_COUNT},
      "size": "${ZIP_SIZE}"
    },
    "infra_release_zip": {
      "path": "dist/infra-release.zip",
      "exists": $([ -f "dist/infra-release.zip" ] && echo true || echo false)
    }
  },
  "sub_reports": {
    "audit":  "dist/release-audit-report.json",
    "smoke":  "dist/release-smoke-report.json"
  }
}
EOJSON

_info "Relatório gate: $REPORT"
_info "Log de timing: $TIMING_LOG"
timelog "release:gate end status=${OVERALL_STATUS} duration_s=${TOTAL_ELAPSED} pass=${PASS_GATES} fail=${FAIL_GATES}"

# ════════════════════════════════════════════════════════════════════════════
# VEREDICTO FINAL
# ════════════════════════════════════════════════════════════════════════════
if [[ "$GATE_FAIL" -ne 0 ]]; then
  printf "\n${RED}${BOLD}╔══════════════════════════════════════════════════════════════════╗${NC}\n"
  printf "${RED}${BOLD}║  ✗  RELEASE:GATE FAIL  —  %d gate(s) falharam                    ║${NC}\n" "$FAIL_GATES"
  printf "${RED}${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}\n\n"
  exit 1
fi

printf "\n${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${GREEN}${BOLD}║  ✓  RELEASE:GATE OK  —  Todos os %d gates verdes (%ds)           ║${NC}\n" \
  "$PASS_GATES" "$TOTAL_ELAPSED"
printf "${GREEN}${BOLD}║     Release aprovado para distribuição                           ║${NC}\n"
printf "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════════╝${NC}\n\n"
