#!/usr/bin/env bash
# discovery:gate — gate enterprise que coleta TODAS as falhas antes de decidir GO/NO_GO
# NÃO para na primeira falha: executa todos os passos e gera relatório completo
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

mkdir -p dist/discovery-validation dist
TIMING_LOG="dist/discovery-gate-timing.log"
REPORT_JSON="dist/discovery-validation/final-report.json"
REPORT_MD="dist/discovery-validation/final-report.md"

: > "$TIMING_LOG"
timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
timelog() { printf '%s | %s\n' "$(timestamp)" "$1" >> "$TIMING_LOG"; }

echo "[discovery:gate] Iniciando gate enterprise do Discovery Engine"
echo "[discovery:gate] Todos os passos serão executados — falhas coletadas sem parar"
timelog "discovery:gate start"

# Estruturas de resultado
STEP_NAMES=()
STEP_STATUS=()
STEP_LOGS=()

resolve_npm() {
  command -v npm 2>/dev/null || \
    find /var/lib/docker/overlay2 -name npm -type f -executable 2>/dev/null | head -1 || \
    echo ""
}

run_step() {
  local idx="$1"
  local label="$2"
  shift 2
  local log_file="dist/discovery-validation/step-${idx}.log"
  local t0
  t0="$(date +%s)"

  echo
  echo "=================================================="
  echo "[discovery:gate] ${label}"
  echo "=================================================="
  timelog "step_start idx=${idx} label=${label}"

  # Rodar sem -e para capturar exit code sem abortar o script
  set +e
  "$@" 2>&1 | tee "$log_file"
  local exit_code=${PIPESTATUS[0]}
  set -e

  local t1
  t1="$(date +%s)"
  local duration=$((t1 - t0))

  STEP_NAMES+=("$label")
  STEP_LOGS+=("$log_file")

  if [[ $exit_code -eq 0 ]]; then
    STEP_STATUS+=("PASS")
    echo "[discovery:gate] PASS: ${label} (${duration}s)"
    timelog "step_end idx=${idx} status=PASS duration=${duration}s"
  else
    STEP_STATUS+=("FAIL")
    echo "[discovery:gate] FAIL: ${label} (exit=${exit_code} ${duration}s)"
    timelog "step_end idx=${idx} status=FAIL exit=${exit_code} duration=${duration}s"
  fi
}

# ------------------------------------------------------------------
# FASE 1 — Testes e linting
# ------------------------------------------------------------------

NPM="$(resolve_npm)"

run_step "01" "discovery:test" bash -c "
  npm_cmd='${NPM}'
  if [[ -z \"\$npm_cmd\" ]]; then echo 'npm não encontrado'; exit 1; fi
  \"\$npm_cmd\" --prefix ./r-observe/discovery test
"

run_step "02" "discovery:lint" bash ./scripts/discovery/discovery-lint.sh

# ------------------------------------------------------------------
# FASE 2 — Auditorias estruturais
# ------------------------------------------------------------------

run_step "03" "discovery:audit" bash ./scripts/discovery/discovery-audit.sh

run_step "04" "discovery:migrations:audit" bash ./scripts/discovery/discovery-migrations-audit.sh

# ------------------------------------------------------------------
# FASE 3 — Doctor (ambiente)
# ------------------------------------------------------------------

run_step "05" "discovery:doctor" node ./scripts/discovery/discovery-doctor.js

# ------------------------------------------------------------------
# FASE 4 — Anti-hardcode e anti-fingerprint
# ------------------------------------------------------------------

run_step "06" "discovery:audit:anti-hardcode" bash ./scripts/discovery/discovery-audit-anti-hardcode.sh

run_step "07" "discovery:audit:fingerprints" bash ./scripts/discovery/discovery-audit-fingerprints.sh

# ------------------------------------------------------------------
# FASE 5 — Smokes
# ------------------------------------------------------------------

run_step "08" "discovery:smoke" bash ./scripts/discovery/discovery-smoke.sh

run_step "09" "discovery:smoke:real" bash ./scripts/discovery/discovery-smoke-real.sh

run_step "10" "discovery:integration" bash ./scripts/discovery/discovery-integration.sh

run_step "11" "discovery:smoke:enterprise" bash ./scripts/discovery/discovery-enterprise-smoke.sh

# ------------------------------------------------------------------
# CONSOLIDAÇÃO
# ------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
FAILURES_JSON="[]"
CHECKS_JSON="["
COMMANDS_JSON="["

for i in "${!STEP_NAMES[@]}"; do
  name="${STEP_NAMES[$i]}"
  status="${STEP_STATUS[$i]}"
  log="${STEP_LOGS[$i]}"
  idx_str=$(printf '%02d' $((i + 1)))

  CHECKS_JSON+=$(printf '{"step":"%s","status":"%s","log":"%s"}' "$name" "$status" "$log")
  COMMANDS_JSON+=$(printf '"%s"' "$name")
  [[ $((i + 1)) -lt ${#STEP_NAMES[@]} ]] && CHECKS_JSON+="," && COMMANDS_JSON+=","

  if [[ "$status" == "PASS" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

CHECKS_JSON+="]"
COMMANDS_JSON+="]"

# Coletar falhas reais
FAILURES_ARR=()
for i in "${!STEP_NAMES[@]}"; do
  if [[ "${STEP_STATUS[$i]}" == "FAIL" ]]; then
    FAILURES_ARR+=("${STEP_NAMES[$i]}")
  fi
done

# ------------------------------------------------------------------
# Determinar GO/NO_GO
# ------------------------------------------------------------------

if [[ $FAIL_COUNT -eq 0 ]]; then
  GATE_STATUS="GO"
  ENTERPRISE_APPROVED="true"
  DECISION_REASON="Todos os ${PASS_COUNT} passos passaram. Sem fingerprints artificiais. Sem hardcode proibido. Migrations canônicas. Inference multi-evidência. Smoke real confirmado."
else
  GATE_STATUS="NO_GO"
  ENTERPRISE_APPROVED="false"
  FAILED_LIST="${FAILURES_ARR[*]}"
  DECISION_REASON="${FAIL_COUNT} passo(s) falharam: ${FAILED_LIST}. Corrigir antes de aprovar."
fi

GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
GENERATED_AT="$(timestamp)"
ENV_MODE="${OBSERVE_MODE:-host-dev}"

# ------------------------------------------------------------------
# Salvar logs principais
# ------------------------------------------------------------------

copy_if_exists() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then cp "$src" "$dst"; fi
}

for i in "${!STEP_NAMES[@]}"; do
  name="${STEP_NAMES[$i]}"
  log="${STEP_LOGS[$i]}"
  case "$name" in
    "discovery:test")                copy_if_exists "$log" dist/discovery-validation/test.log ;;
    "discovery:lint")                copy_if_exists "$log" dist/discovery-validation/lint.log ;;
    "discovery:audit")               copy_if_exists "$log" dist/discovery-validation/audit.log ;;
    "discovery:migrations:audit")    copy_if_exists "$log" dist/discovery-validation/migrations.log ;;
    "discovery:doctor")              copy_if_exists "$log" dist/discovery-validation/doctor.log ;;
    "discovery:smoke:real")          copy_if_exists "$log" dist/discovery-validation/smoke-real.log ;;
    "discovery:audit:anti-hardcode") copy_if_exists "$log" dist/discovery-validation/anti-hardcode.log ;;
    "discovery:audit:fingerprints")  copy_if_exists "$log" dist/discovery-validation/fingerprints.log ;;
  esac
done

copy_if_exists "$TIMING_LOG" dist/discovery-validation/gate.log

# ------------------------------------------------------------------
# Gerar final-report.json
# ------------------------------------------------------------------

node -e "
const fs = require('fs');

const checks = $CHECKS_JSON;
const commands = $COMMANDS_JSON;
const failures = checks.filter(c => c.status === 'FAIL').map(c => c.step);
const warnings = [];

// Warnings da doctor (environmentUnavailable)
try {
  const doctor = JSON.parse(fs.readFileSync('dist/discovery-doctor.json', 'utf8'));
  if (doctor.environmentUnavailable && doctor.environmentUnavailable.length) {
    for (const eu of doctor.environmentUnavailable) {
      warnings.push('environment-unavailable: ' + eu.check);
    }
  }
} catch (_) {}

const report = {
  status: '$GATE_STATUS',
  enterpriseApproved: $ENTERPRISE_APPROVED,
  generatedAt: '$GENERATED_AT',
  gitCommit: '$GIT_COMMIT',
  environment: '$ENV_MODE',
  commands,
  checks,
  failures,
  warnings,
  environmentUnavailable: [],
  evidence: [
    'discovery:test: ' + (checks.find(c=>c.step==='discovery:test')?.status||'?'),
    'discovery:lint: ' + (checks.find(c=>c.step==='discovery:lint')?.status||'?'),
    'discovery:audit: ' + (checks.find(c=>c.step==='discovery:audit')?.status||'?'),
    'discovery:migrations:audit: ' + (checks.find(c=>c.step==='discovery:migrations:audit')?.status||'?'),
    'discovery:doctor: ' + (checks.find(c=>c.step==='discovery:doctor')?.status||'?'),
    'discovery:audit:anti-hardcode: ' + (checks.find(c=>c.step==='discovery:audit:anti-hardcode')?.status||'?'),
    'discovery:audit:fingerprints: ' + (checks.find(c=>c.step==='discovery:audit:fingerprints')?.status||'?'),
    'discovery:smoke:real: ' + (checks.find(c=>c.step==='discovery:smoke:real')?.status||'?'),
    'discovery:smoke:enterprise: ' + (checks.find(c=>c.step==='discovery:smoke:enterprise')?.status||'?'),
  ],
  artifacts: {
    test_log:            'dist/discovery-validation/test.log',
    lint_log:            'dist/discovery-validation/lint.log',
    audit_log:           'dist/discovery-validation/audit.log',
    migrations_log:      'dist/discovery-validation/migrations.log',
    doctor_log:          'dist/discovery-validation/doctor.log',
    smoke_real_log:      'dist/discovery-validation/smoke-real.log',
    anti_hardcode_log:   'dist/discovery-validation/anti-hardcode.log',
    fingerprints_log:    'dist/discovery-validation/fingerprints.log',
    gate_log:            'dist/discovery-validation/gate.log',
    doctor_json:         'dist/discovery-doctor.json',
    smoke_real_json:     'dist/discovery-smoke-real.json',
    migrations_json:     'dist/discovery-migrations-audit.json',
    anti_hardcode_json:  'dist/discovery-audit-anti-hardcode.json',
    fingerprints_json:   'dist/discovery-audit-fingerprints.json',
    final_report_json:   '$REPORT_JSON',
  },
  decisionReason: '$DECISION_REASON',
};

fs.writeFileSync('$REPORT_JSON', JSON.stringify(report, null, 2));
console.log('[discovery:gate] final-report.json salvo: $REPORT_JSON');
" 2>&1

# ------------------------------------------------------------------
# Gerar final-report.md
# ------------------------------------------------------------------

node -e "
const fs = require('fs');
const r = JSON.parse(fs.readFileSync('$REPORT_JSON', 'utf8'));

const lines = [
  '# Discovery Engine — Relatório Final Enterprise',
  '',
  '| Campo | Valor |',
  '|---|---|',
  '| **Status** | ' + r.status + ' |',
  '| **Enterprise Approved** | ' + r.enterpriseApproved + ' |',
  '| **Gerado em** | ' + r.generatedAt + ' |',
  '| **Git commit** | \`' + r.gitCommit + '\` |',
  '| **Ambiente** | ' + r.environment + ' |',
  '',
  '## Decisão',
  '',
  r.decisionReason,
  '',
  '## Passos executados',
  '',
];
for (const c of r.checks) {
  lines.push('- [' + c.status + '] \`' + c.step + '\`');
}
if (r.failures.length) {
  lines.push('', '## Falhas', '');
  for (const f of r.failures) lines.push('- [FAIL] ' + f);
}
if (r.warnings.length) {
  lines.push('', '## Avisos', '');
  for (const w of r.warnings) lines.push('- ' + w);
}
lines.push('', '## Artefatos', '');
for (const [k, v] of Object.entries(r.artifacts)) {
  lines.push('- \`' + v + '\`');
}
lines.push('', '---', '_Gerado por discovery:gate_');

fs.writeFileSync('$REPORT_MD', lines.join('\n'));
console.log('[discovery:gate] final-report.md salvo: $REPORT_MD');
" 2>&1

# ------------------------------------------------------------------
# Resultado final
# ------------------------------------------------------------------

echo
echo "=================================================="
echo "[discovery:gate] RESULTADO FINAL"
echo "=================================================="
echo "[discovery:gate] Passos: ${PASS_COUNT} PASS / ${FAIL_COUNT} FAIL"
echo "[discovery:gate] Status: ${GATE_STATUS}"
echo "[discovery:gate] Enterprise approved: ${ENTERPRISE_APPROVED}"
echo "[discovery:gate] Relatório: ${REPORT_JSON}"

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo
  echo "[discovery:gate] Falhas:"
  for name in "${FAILURES_ARR[@]}"; do
    echo "  [FAIL] ${name}"
  done
  echo
  echo "[discovery:gate] NO_GO — corrigir falhas antes de aprovar"
  timelog "discovery:gate end status=NO_GO fail=${FAIL_COUNT}"
  exit 1
fi

timelog "discovery:gate end status=GO"
echo
echo "[discovery:gate] GO — todos os ${PASS_COUNT} passos passaram"
