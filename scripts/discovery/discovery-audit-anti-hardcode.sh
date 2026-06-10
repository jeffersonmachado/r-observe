#!/usr/bin/env bash
# Auditoria anti-hardcode: detecta classificação determinística por porta/banner
# PERMITIDO: porta como gate para probe real, hints fracos (confidence <= 0.15)
# PROIBIDO: porta ou banner como classificação final sem pipeline de inferência
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

SRC="r-observe/discovery/src"
FAIL=0
REPORT_FILE="dist/discovery-audit-anti-hardcode.json"
mkdir -p dist

log_fail() { echo "[FAIL] $1"; FAIL=1; }
log_pass() { echo "[PASS] $1"; }
log_info() { echo "[INFO] $1"; }

echo "[discovery:audit:anti-hardcode] Verificando padrões proibidos de hardcode"

# ------------------------------------------------------------------
# 1. Strings sintéticas proibidas (fora de testes e documentação)
# ------------------------------------------------------------------

check_forbidden_string() {
  local pattern="$1"
  local label="$2"
  local hits
  hits=$(grep -rn "$pattern" "$SRC" \
    --include="*.js" \
    --exclude-dir="{tests,test,__tests__,fixtures,docs}" \
    2>/dev/null | grep -v "//.*$pattern" | head -5)
  if [[ -n "$hits" ]]; then
    log_fail "string proibida '$label' encontrada em src:"
    echo "$hits" | while read -r line; do echo "    $line"; done
  else
    log_pass "string proibida '$label' ausente em src"
  fi
}

check_forbidden_string "SIP-UA-unknown"   "SIP-UA-unknown"
check_forbidden_string "ONVIF-possible"   "ONVIF-possible"
check_forbidden_string "RTSP-possible"    "RTSP-possible"
check_forbidden_string "camera-possible"  "camera-possible"

# ------------------------------------------------------------------
# 2. Classificação direta por porta — atribuição de technology/category
#    baseada em número de porta sem passar por inference pipeline
# ------------------------------------------------------------------

# Proibido: if (port === 5060) return { technology: 'sip' }
# Proibido: category = 'voice'  (dentro de if port === 5060)
# Permitido: open.includes(5060) como gate para probeSipOptions (scanner)
# A distinção: probe gate em scanners é ok; retorno de classificação é proibido

FORBIDDEN_DIRECT_PORT_CLASS=$(grep -rn \
  "port.*===.*5060.*technology\|port.*===.*554.*technology\|port.*===.*161.*technology\|port.*===.*80.*category\|port.*===.*443.*category" \
  "$SRC" --include="*.js" \
  --exclude-dir="{tests,test,__tests__,fixtures}" \
  2>/dev/null | head -10)

if [[ -n "$FORBIDDEN_DIRECT_PORT_CLASS" ]]; then
  log_fail "classificação direta de technology/category por porta encontrada:"
  echo "$FORBIDDEN_DIRECT_PORT_CLASS" | while read -r line; do echo "    $line"; done
else
  log_pass "sem classificação direta de technology/category por porta"
fi

# ------------------------------------------------------------------
# 3. PORT_HINTS usado como valor de retorno final (não como evidence)
#    Proibido: return PORT_HINTS[port] diretamente como classificação
# ------------------------------------------------------------------

PHINTS_AS_RETURN=$(grep -n "return.*PORT_HINTS\[" "$SRC/inference/engine.js" 2>/dev/null | head -5)
if [[ -n "$PHINTS_AS_RETURN" ]]; then
  log_fail "PORT_HINTS retornado diretamente como classificação:"
  echo "$PHINTS_AS_RETURN" | while read -r line; do echo "    $line"; done
else
  log_pass "PORT_HINTS não retornado diretamente como classificação"
fi

# PORT_HINTS devem ter confidence <= 0.15 (weak hint)
PORT_HINT_CONFIDENCE=$(node -e "
const reg = require('./r-observe/discovery/src/inference/registry/inference-registry.json');
const hints = reg.port_hints || {};
// hints são usados com confidence 0.12 no engine — verificar que nenhuma rule weight
// para tcp_open_port/udp_open_port seja > 0.2
const rules = reg.rules || [];
const violations = [];
for (const rule of rules) {
  const w = rule.weights || {};
  if ((w.tcp_open_port || 0) > 0.20) violations.push(rule.asset_type + ':tcp_weight=' + w.tcp_open_port);
  if ((w.udp_open_port || 0) > 0.20) violations.push(rule.asset_type + ':udp_weight=' + w.udp_open_port);
}
if (violations.length) { console.log('VIOLATION:' + violations.join(',')); process.exit(1); }
else { console.log('OK'); }
" 2>&1)

if echo "$PORT_HINT_CONFIDENCE" | grep -q "^VIOLATION:"; then
  log_fail "peso de porta em regra > 0.20 (forte demais para classificar como hint):"
  echo "    $PORT_HINT_CONFIDENCE"
else
  log_pass "pesos de porta em regras <= 0.20 (sinal fraco — OK)"
fi

# ------------------------------------------------------------------
# 4. Confidence hardcoded = 1.0 fora da função clamp
# ------------------------------------------------------------------

HARDCODED_CONF=$(grep -rn "confidence.*:.*1\.0\b\|confidence.*=.*1\.0\b" "$SRC" \
  --include="*.js" \
  --exclude-dir="{tests,test,__tests__,fixtures}" \
  2>/dev/null | grep -v "clamp\|max\|Math\|//\|parseFloat" | head -10)

if [[ -n "$HARDCODED_CONF" ]]; then
  log_fail "confidence hardcoded em 1.0 (fora de clamp) encontrado:"
  echo "$HARDCODED_CONF" | while read -r line; do echo "    $line"; done
else
  log_pass "sem confidence hardcoded em 1.0 fora de clamp"
fi

# ------------------------------------------------------------------
# 5. Threshold hardcoded fora do registry
#    Proibido: if (score >= 0.85) em source (deve vir de THRESHOLDS)
# ------------------------------------------------------------------

HARDCODED_THRESH=$(grep -rn "score.*>=.*0\.[0-9]\+\|score.*<=.*0\.[0-9]\+" "$SRC" \
  --include="*.js" \
  --exclude-dir="{tests,test,__tests__,fixtures}" \
  2>/dev/null | grep -v "THRESHOLDS\|thresholds\|registry\|//\|test\|spec" | head -10)

if [[ -n "$HARDCODED_THRESH" ]]; then
  log_fail "threshold hardcoded encontrado fora de THRESHOLDS/registry:"
  echo "$HARDCODED_THRESH" | while read -r line; do echo "    $line"; done
else
  log_pass "sem threshold hardcoded fora de THRESHOLDS/registry"
fi

# ------------------------------------------------------------------
# 6. Verificar minimum_evidence_to_classify >= 2 no registry
# ------------------------------------------------------------------

MIN_EV=$(node -e "
const reg = require('./r-observe/discovery/src/inference/registry/inference-registry.json');
const min = reg.thresholds && reg.thresholds.minimum_evidence_to_classify;
if (!min || min < 2) { console.log('FAIL:' + min); process.exit(1); }
else console.log('OK:' + min);
" 2>&1)

if echo "$MIN_EV" | grep -q "^FAIL:"; then
  log_fail "minimum_evidence_to_classify < 2 no registry: $MIN_EV"
else
  log_pass "minimum_evidence_to_classify >= 2 no registry ($MIN_EV)"
fi

# ------------------------------------------------------------------
# 7. Verificar que PORT_HINTS é usado apenas como evidence de baixa
#    confiança no engine (confidence = 0.12 na linha de port hint)
# ------------------------------------------------------------------

PORT_HINT_LINE=$(grep -n "PORT_HINTS\[port\]\|PORT_HINTS\[" "$SRC/inference/engine.js" 2>/dev/null)
PORT_HINT_CONF_VAL=$(echo "$PORT_HINT_LINE" | grep -v "registry\|const PORT" | head -3)

# Verificar que a linha que usa PORT_HINTS usa 0.12 como confidence
PORT_HINT_USAGE=$(grep -A2 "PORT_HINTS\[port\]" "$SRC/inference/engine.js" 2>/dev/null | head -6)
if echo "$PORT_HINT_USAGE" | grep -q "0\.12"; then
  log_pass "PORT_HINTS usado com confidence 0.12 (sinal fraco) no engine"
else
  log_fail "PORT_HINTS pode estar sendo usado com confidence incorreta:"
  echo "$PORT_HINT_USAGE" | while read -r line; do echo "    $line"; done
fi

# ------------------------------------------------------------------
# 8. Inferência declarativa: INFERENCE_REGISTRY vem de JSON, não inline
# ------------------------------------------------------------------

INLINE_RULES=$(grep -n "asset_type.*:.*['\"]camera\|asset_type.*:.*['\"]voice\|asset_type.*:.*['\"]database" \
  "$SRC/inference/engine.js" 2>/dev/null | grep -v "require\|registry\|rule\." | head -5)

if [[ -n "$INLINE_RULES" ]]; then
  log_fail "regras de inferência inline no engine (deve vir do registry JSON):"
  echo "$INLINE_RULES" | while read -r line; do echo "    $line"; done
else
  log_pass "regras de inferência carregadas do registry JSON (não inline)"
fi

# ------------------------------------------------------------------
# Relatório final
# ------------------------------------------------------------------

STATUS="GO"
[[ $FAIL -ne 0 ]] && STATUS="NO_GO"

node -e "
const fs = require('fs');
const report = {
  status: '$STATUS',
  generatedAt: new Date().toISOString(),
  checks_passed: $((FAIL == 0 ? 1 : 0)),
  audit: 'anti-hardcode',
};
fs.writeFileSync('$REPORT_FILE', JSON.stringify(report, null, 2));
console.log('[discovery:audit:anti-hardcode] status=$STATUS report=$REPORT_FILE');
"

exit $FAIL
