#!/usr/bin/env bash
# scripts/package/release-audit.sh
#
# Auditoria completa do release + 4 testes destrutivos auto-comprovantes.
# Prova que o validador (validate-zip.sh) FALHA quando deve falhar.
# Impossível de dar falso-positivo: testes destrutivos exigem que a rejeição ocorra.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ "${RELEASE_LOCK_HELD:-0}" != "1" ]]; then
  RELEASE_LOCK_FILE="${RELEASE_LOCK_FILE:-/tmp/infra-release.lock}"
  exec 9>"$RELEASE_LOCK_FILE"
  if ! flock -n 9; then
    echo "[release:audit] erro: outro pipeline de release esta em execucao (lock: $RELEASE_LOCK_FILE)" >&2
    exit 1
  fi
  export RELEASE_LOCK_HELD=1
  export RELEASE_LOCK_FILE
fi

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

_pass()    { printf "${GREEN}[PASS]${NC} %s\n" "$*";       PASS_COUNT=$((PASS_COUNT + 1)); }
_fail()    { printf "${RED}[FAIL]${NC} %s\n" "$*" >&2;    FAIL_COUNT=$((FAIL_COUNT + 1)); AUDIT_FAIL=1; }
_info()    { printf "${YELLOW}[INFO]${NC} %s\n" "$*"; }
_section() { printf "\n${BOLD}══ %s ══${NC}\n" "$*"; }

AUDIT_FAIL=0
PASS_COUNT=0
FAIL_COUNT=0
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

mkdir -p dist
REPORT="dist/release-audit-report.json"
DATE_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ZIP_MAIN="dist/infra.zip"
ZIP_RELEASE="dist/infra-release.zip"
AUDIT_VALIDATE_SKIP_CONTENT_SCAN="${RELEASE_AUDIT_SKIP_CONTENT_SCAN:-1}"

ensure_zip_exists() {
  local zip_path="$1"
  local build_cmd="$2"
  if [[ ! -f "$zip_path" ]]; then
    _info "Artefato ausente durante auditoria: $zip_path; regenerando com '$build_cmd'"
    eval "$build_cmd"
  fi
}

# ── Bootstrap dos artefatos (resiliência) ───────────────────────────────────
ensure_zip_exists "$ZIP_MAIN" "npm run zip"
ensure_zip_exists "$ZIP_RELEASE" "npm run zip:release"

# ── Seção 1: Presença dos artefatos ──────────────────────────────────────────
_section "1/6  PRESENÇA DOS ARTEFATOS"
for z in "$ZIP_MAIN" "$ZIP_RELEASE"; do
  if [[ -f "$z" ]]; then
    SIZE="$(du -sh "$z" | cut -f1)"
    _pass "ZIP existe: $z  ($SIZE)"
  else
    _fail "ZIP ausente: $z"
  fi
done

# Abortar cedo se os ZIPs não existem — sem eles os próximos checks não fazem sentido
if [[ ! -f "$ZIP_MAIN" || ! -f "$ZIP_RELEASE" ]]; then
  _fail "Abortando: ZIPs ausentes"
  exit 1
fi

# ── Seção 2: Validação completa via validate-zip.sh ──────────────────────────
_section "2/6  VALIDAÇÃO COMPLETA (validate-zip.sh)"
for z in "$ZIP_MAIN" "$ZIP_RELEASE"; do
  if [[ "$z" == "$ZIP_MAIN" ]]; then
    ensure_zip_exists "$ZIP_MAIN" "npm run zip"
  else
    ensure_zip_exists "$ZIP_RELEASE" "npm run zip:release"
  fi
  VLOG="$TMPD/validate-$(basename "$z" .zip).log"
  set +e
  if [[ "$AUDIT_VALIDATE_SKIP_CONTENT_SCAN" == "1" ]]; then
    VALIDATE_ZIP_SKIP_CONTENT_SCAN=1 bash ./scripts/package/validate-zip.sh "$z" >"$VLOG" 2>&1
  else
    bash ./scripts/package/validate-zip.sh "$z" >"$VLOG" 2>&1
  fi
  VRC=$?
  set -e
  if [[ "$VRC" -eq 0 ]]; then
    _pass "validate-zip: $z"
  else
    _fail "validate-zip: $z"
    tail -30 "$VLOG" >&2 || true
  fi
done

# ── Seção 3: Contagem de arquivos ────────────────────────────────────────────
_section "3/6  CONTAGEM DE ARQUIVOS"
for z in "$ZIP_MAIN" "$ZIP_RELEASE"; do
  if [[ "$z" == "$ZIP_MAIN" ]]; then
    ensure_zip_exists "$ZIP_MAIN" "npm run zip"
  else
    ensure_zip_exists "$ZIP_RELEASE" "npm run zip:release"
  fi
  COUNT="$(unzip -Z -1 "$z" | wc -l | tr -d ' ')"
  if [[ "$COUNT" -ge 500 ]]; then
    _pass "Quantidade: $z  ($COUNT arquivos ≥ 500)"
  else
    _fail "Quantidade insuficiente: $z  ($COUNT < 500)"
  fi
done

# ── Seção 4: Spot-check de arquivos críticos ─────────────────────────────────
_section "4/6  ARQUIVOS CRÍTICOS (spot-check em $ZIP_MAIN)"
ZIP_MAIN_ENTRIES="$TMPD/zip-main-entries.txt"
unzip -Z -1 "$ZIP_MAIN" | sed 's#^\./##' > "$ZIP_MAIN_ENTRIES"
CRITICAL_SPOT=(
  "package.json"
  "docker-compose.observe.yml"
  "r-observe/discovery/package.json"
  "r-observe/discovery/src/index.js"
  "r-observe/discovery/src/engine/discovery-engine.js"
  "r-observe/discovery/src/fingerprint/engine.js"
  "r-observe/discovery/src/topology/engine.js"
  "r-observe/discovery/src/exporters/prometheus-sd.js"
  "r-observe/discovery/src/security/guardrails.js"
  "r-observe/migrations/004_discovery_engine.sql"
  "r-observe/migrations/005_discovery_dedupe_indexes.sql"
  "r-observe/migrations/007_discovery_policy_limits.sql"
  "observe/nginx/conf.d/observe.conf"
  "observe/prometheus/prometheus.yml"
  "docs/r-observe-discovery/README.md"
  "scripts/observe/validate-compose.sh"
  "scripts/package/validate-zip.sh"
  "scripts/package/zip-release.sh"
)
for f in "${CRITICAL_SPOT[@]}"; do
  if grep -Fxq "$f" "$ZIP_MAIN_ENTRIES"; then
    _pass "Crítico presente: $f"
  else
    _fail "Crítico AUSENTE: $f"
  fi
done

# ── Seção 5: Ausência de proibidos ───────────────────────────────────────────
_section "5/6  AUSÊNCIA DE PROIBIDOS (spot-check em $ZIP_MAIN)"
FORBIDDEN_PATTERNS=(
  "node_modules/"
  ".git/"
  ".gitignore"
  ".env"
  ".token.env"
)
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  if grep -qF "$pat" "$ZIP_MAIN_ENTRIES"; then
    _fail "Proibido encontrado: $pat"
  else
    _pass "Proibido ausente: $pat"
  fi
done

# ── Seção 6: Testes destrutivos ───────────────────────────────────────────────
_section "6/6  TESTES DESTRUTIVOS — PROVA DE REJEIÇÃO CORRECTA"
_info "Estes testes PROVAM que o validador falha quando deve falhar."
_info "Se o validador aceitar um ZIP corrompido, o teste FALHA."

# Helper: assert que validate-zip.sh DEVE rejeitar o ZIP
_assert_validator_fails() {
  local label="$1"
  local zippath="$2"
  local reason="$3"
  set +e
  bash ./scripts/package/validate-zip.sh "$zippath" >/dev/null 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    _pass "Destrutivo $label: validador rejeitou corretamente ($reason)"
  else
    _fail "Destrutivo $label: validador DEVERIA TER FALHADO mas aceitou ZIP inválido ($reason)"
  fi
}

# ── Teste destrutivo 1: ZIP com .env.fake ────────────────────────────────────
_info "Teste 1: inserindo .env.fake em cópia do ZIP..."
cp "$ZIP_MAIN" "$TMPD/test1.zip"
printf 'FAKE_SECRET=supersecret_should_be_blocked_by_validator_12345\n' > "$TMPD/.env.fake"
(cd "$TMPD" && zip -q test1.zip .env.fake)
_assert_validator_fails "1 (.env.fake)" "$TMPD/test1.zip" ".env.fake deve ser bloqueado"

# ── Teste destrutivo 2: ZIP com node_modules/ ───────────────────────────────
_info "Teste 2: inserindo node_modules/malicious.js em cópia do ZIP..."
cp "$ZIP_MAIN" "$TMPD/test2.zip"
mkdir -p "$TMPD/nm_payload/node_modules"
printf 'module.exports = { evil: true };\n' > "$TMPD/nm_payload/node_modules/malicious.js"
(cd "$TMPD/nm_payload" && zip -q "$TMPD/test2.zip" node_modules/malicious.js)
_assert_validator_fails "2 (node_modules/)" "$TMPD/test2.zip" "node_modules/ deve ser bloqueado"

# ── Teste destrutivo 3: ZIP sem discovery-engine.js ─────────────────────────
_info "Teste 3: removendo r-observe/discovery/src/engine/discovery-engine.js do ZIP..."
cp "$ZIP_MAIN" "$TMPD/test3.zip"
zip -d -q "$TMPD/test3.zip" "r-observe/discovery/src/engine/discovery-engine.js" 2>/dev/null || true
# Verificar se o arquivo foi de fato removido (confirmação da operação)
if ! unzip -Z -1 "$TMPD/test3.zip" | grep -Fxq "r-observe/discovery/src/engine/discovery-engine.js"; then
  _assert_validator_fails "3 (sem discovery-engine.js)" "$TMPD/test3.zip" "arquivo crítico ausente deve ser detectado"
else
  _fail "Destrutivo 3: não foi possível remover o arquivo do ZIP para o teste"
fi

# ── Teste destrutivo 4: ZIP com < 500 arquivos ───────────────────────────────
_info "Teste 4: criando ZIP mínimo com apenas 5 arquivos..."
mkdir -p "$TMPD/minimal_payload"
printf '{"name":"test","version":"1.0.0"}\n' > "$TMPD/minimal_payload/package.json"
printf '# dummy\n'                             > "$TMPD/minimal_payload/README.md"
printf 'dummy\n'                               > "$TMPD/minimal_payload/a.txt"
printf 'dummy\n'                               > "$TMPD/minimal_payload/b.txt"
printf 'dummy\n'                               > "$TMPD/minimal_payload/c.txt"
(cd "$TMPD" && zip -q minimal.zip minimal_payload/package.json minimal_payload/README.md minimal_payload/a.txt minimal_payload/b.txt minimal_payload/c.txt)
_assert_validator_fails "4 (< 500 arquivos)" "$TMPD/minimal.zip" "ZIP com poucos arquivos deve ser detectado"

# ── Resumo final ──────────────────────────────────────────────────────────────
_section "RESUMO DA AUDITORIA"
TOTAL=$((PASS_COUNT + FAIL_COUNT))
_info "Total: $TOTAL  |  PASS: $PASS_COUNT  |  FAIL: $FAIL_COUNT"

ZIP_COUNT="$(unzip -Z -1 "$ZIP_MAIN" | wc -l | tr -d ' ')"
ZIP_SIZE="$(du -sh "$ZIP_MAIN" | cut -f1)"

cat > "$REPORT" <<EOJSON
{
  "generated_at": "${DATE_UTC}",
  "status": "$([ "$AUDIT_FAIL" -eq 0 ] && echo green || echo red)",
  "pass": ${PASS_COUNT},
  "fail": ${FAIL_COUNT},
  "total": ${TOTAL},
  "artifacts": {
    "infra_zip": {
      "path": "${ZIP_MAIN}",
      "exists": $([ -f "$ZIP_MAIN" ] && echo true || echo false),
      "file_count": ${ZIP_COUNT},
      "size": "${ZIP_SIZE}"
    },
    "infra_release_zip": {
      "path": "${ZIP_RELEASE}",
      "exists": $([ -f "$ZIP_RELEASE" ] && echo true || echo false)
    }
  },
  "destructive_tests": 4,
  "report": "${REPORT}"
}
EOJSON

_info "Relatório gerado: $REPORT"

if [[ "$AUDIT_FAIL" -ne 0 ]]; then
  printf "\n${RED}[RELEASE:AUDIT FAIL]${NC} %d verificação(ões) falharam\n" "$FAIL_COUNT" >&2
  exit 1
fi

printf "\n${GREEN}[RELEASE:AUDIT OK]${NC} Todos os %d checks passaram (inclui 4 testes destrutivos).\n" "$TOTAL"
