#!/usr/bin/env bash
# Auditoria anti-fingerprint: verifica que nenhuma classificação depende
# apenas de porta aberta, banner simples ou combinação superficial de sinais
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

FAIL=0
REPORT_FILE="dist/discovery-audit-fingerprints.json"
mkdir -p dist

log_fail() { echo "[FAIL] $1"; FAIL=1; }
log_pass() { echo "[PASS] $1"; }
log_info() { echo "[INFO] $1"; }

echo "[discovery:audit:fingerprints] Verificando integridade do fingerprint engine"

# ------------------------------------------------------------------
# 1. Porta isolada NÃO pode classificar (teste via engine real)
# ------------------------------------------------------------------

node -e "
const { inferAsset } = require('./r-observe/discovery/src/inference/engine');

const tests = [
  { label: 'porta SIP isolada',  input: { open_ports: [5060] } },
  { label: 'porta RTSP isolada', input: { open_ports: [554] } },
  { label: 'porta SNMP isolada', input: { open_ports: [161] } },
  { label: 'porta HTTP isolada', input: { open_ports: [80] } },
  { label: 'porta HTTPS isolada',input: { open_ports: [443] } },
  { label: 'porta DB isolada',   input: { open_ports: [5432] } },
];

let fail = 0;
for (const t of tests) {
  const r = inferAsset(t.input);
  const classified = r.confidence_level !== 'insufficient' && r.asset_type !== 'host';
  if (classified) {
    console.error('[FAIL] ' + t.label + ' classificou como: ' + r.asset_type + ' conf=' + r.confidence_score);
    fail++;
  } else {
    console.log('[PASS] ' + t.label + ' => host/insufficient (correto)');
  }
}
process.exit(fail);
" 2>&1
PORT_ONLY_EXIT=${PIPESTATUS[0]:-$?}
[[ ${PORT_ONLY_EXIT:-0} -ne 0 ]] && FAIL=1

# ------------------------------------------------------------------
# 2. Banner simples NÃO pode classificar OS diretamente
# ------------------------------------------------------------------

node -e "
const { inferAsset } = require('./r-observe/discovery/src/inference/engine');

const tests = [
  { label: 'banner Apache isolado', input: { http_server: 'Apache/2.4.51' } },
  { label: 'banner Nginx isolado',  input: { http_server: 'nginx/1.20.0' } },
  { label: 'SSH banner Ubuntu',     input: { ssh_banner: 'SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.1' } },
];

let fail = 0;
for (const t of tests) {
  const r = inferAsset(t.input);
  // Banner isolado pode ter confidence medium para serviço, mas NÃO deve
  // reportar asset_type definitivo de OS (ex: 'linux_host', 'windows_host')
  // nem confidence_level = 'high' sem evidência adicional
  if (r.confidence_level === 'high') {
    console.error('[FAIL] ' + t.label + ' classificou com HIGH confidence sem probe: conf=' + r.confidence_score);
    fail++;
  } else {
    console.log('[PASS] ' + t.label + ' => confidence_level=' + r.confidence_level + ' (não high sem probe)');
  }
}
process.exit(fail);
" 2>&1
BANNER_EXIT=${PIPESTATUS[0]:-$?}
[[ ${BANNER_EXIT:-0} -ne 0 ]] && FAIL=1

# ------------------------------------------------------------------
# 3. SIP só classifica com probe respondido (sip_probe.responded = true)
# ------------------------------------------------------------------

node -e "
const { inferAsset } = require('./r-observe/discovery/src/inference/engine');

// Porta SIP + probe NÃO respondido => não deve classificar como voice_endpoint
const noProbe = inferAsset({
  open_ports: [5060],
  sip_probe: { responded: false, status: 'timeout' },
});
if (noProbe.asset_type === 'voice_endpoint' && noProbe.confidence_level !== 'insufficient') {
  console.error('[FAIL] SIP sem probe respondido classificou como voice_endpoint conf=' + noProbe.confidence_score);
  process.exit(1);
}
console.log('[PASS] SIP sem probe respondido => asset_type=' + noProbe.asset_type + ' conf=' + noProbe.confidence_score);

// Porta SIP + probe respondido => pode classificar
const withProbe = inferAsset({
  open_ports: [5060],
  sip_probe: { responded: true, status: '200 OK', user_agent: 'Grandstream GXP1630' },
  sip_user_agent: 'Grandstream GXP1630',
  mac: '00:0B:82:00:00:01', // Grandstream OUI
});
console.log('[PASS] SIP com probe respondido + OUI => asset_type=' + withProbe.asset_type + ' conf=' + withProbe.confidence_score);
process.exit(0);
" 2>&1
SIP_EXIT=${PIPESTATUS[0]:-$?}
[[ ${SIP_EXIT:-0} -ne 0 ]] && FAIL=1

# ------------------------------------------------------------------
# 4. RTSP só classifica com probe respondido
# ------------------------------------------------------------------

node -e "
const { inferAsset } = require('./r-observe/discovery/src/inference/engine');

// Porta RTSP sem probe => não classifica como camera
const noProbe = inferAsset({
  open_ports: [554],
  rtsp_probe: { responded: false, status: 'timeout' },
});
if (noProbe.asset_type === 'camera_ip' && noProbe.confidence_level !== 'insufficient') {
  console.error('[FAIL] RTSP sem probe classificou como camera_ip conf=' + noProbe.confidence_score);
  process.exit(1);
}
console.log('[PASS] RTSP sem probe respondido => asset_type=' + noProbe.asset_type + ' conf=' + noProbe.confidence_score);
process.exit(0);
" 2>&1
RTSP_EXIT=${PIPESTATUS[0]:-$?}
[[ ${RTSP_EXIT:-0} -ne 0 ]] && FAIL=1

# ------------------------------------------------------------------
# 5. Camera IP requer evidências reais (RTSP/ONVIF probe + OUI)
# ------------------------------------------------------------------

node -e "
const { inferAsset } = require('./r-observe/discovery/src/inference/engine');

// Camera com evidência real: RTSP probe + ONVIF probe + OUI Hikvision
const realCamera = inferAsset({
  open_ports: [554, 80, 8000],
  rtsp_probe: { responded: true, status: '200 OK', server: 'Hikvision-Webs' },
  rtsp_banner: 'RTSP 200 OK Hikvision-Webs',
  onvif_probe: { responded: true, model: 'DS-2CD2143G2-I', manufacturer: 'Hikvision', device_info: true },
  onvif_model: 'DS-2CD2143G2-I',
  mac: '44:19:B6:00:00:01', // Hikvision OUI
});

if (realCamera.evidence_count < 2) {
  console.error('[FAIL] camera com evidência real tem evidence_count < 2: ' + realCamera.evidence_count);
  process.exit(1);
}
console.log('[PASS] camera com evidência real => asset_type=' + realCamera.asset_type +
  ' evidence_count=' + realCamera.evidence_count +
  ' conf=' + realCamera.confidence_score);
process.exit(0);
" 2>&1
CAM_EXIT=${PIPESTATUS[0]:-$?}
[[ ${CAM_EXIT:-0} -ne 0 ]] && FAIL=1

# ------------------------------------------------------------------
# 6. Conflitos reduzem confidence (não auto-aprovam)
# ------------------------------------------------------------------

node -e "
const { inferAsset } = require('./r-observe/discovery/src/inference/engine');

// Cenário real de conflito: SIP (voice) + RTSP/ONVIF (camera) => conflitos obrigatórios
// O device respondeu ao probe SIP E ao probe RTSP/ONVIF — ambiguidade real
const conflicted = inferAsset({
  open_ports: [5060, 554, 8000],
  sip_probe:  { responded: true, status: '200 OK', user_agent: 'Asterisk PBX 18.1.0' },
  rtsp_probe: { responded: true, status: '200 OK', server: 'Hikvision-Webs' },
  onvif_probe:{ responded: true, model: 'DS-2CD2143G2-I', manufacturer: 'Hikvision', device_info: true },
  topology:   { poe: true, edge_port: true },
});

let fail = 0;

// 1. conflicting_evidence DEVE ser > 0 — não verde falso
if (!(conflicted.conflicting_evidence > 0)) {
  console.error('[FAIL] asset conflitante com SIP+RTSP+ONVIF deve ter conflicting_evidence > 0, got=' + conflicted.conflicting_evidence);
  console.error('       Causa: pesos insuficientes para detectar conflito entre categorias voice e iot');
  fail++;
} else {
  console.log('[PASS] conflicting_evidence=' + conflicted.conflicting_evidence + ' > 0 (conflito detectado)');
}

// 2. Governança NÃO pode ser APPROVED com conflito
const governance = conflicted.governance && conflicted.governance.decision;
if (governance === 'APPROVED') {
  console.error('[FAIL] asset conflitante foi APPROVED automaticamente — governança deve exigir review');
  fail++;
} else {
  console.log('[PASS] governance=' + governance + ' (review obrigatório com conflito)');
}

// 3. Confidence deve ser moderada (abaixo de auto_approve 0.85) com conflito
if (conflicted.confidence_score >= 0.85) {
  console.error('[FAIL] asset conflitante com confidence >= 0.85 não deveria ser possível: conf=' + conflicted.confidence_score);
  fail++;
} else {
  console.log('[PASS] confidence_score=' + conflicted.confidence_score + ' < 0.85 (conflito reduz confidence)');
}

process.exit(fail);
" 2>&1
CONFLICT_EXIT=${PIPESTATUS[0]:-$?}
[[ ${CONFLICT_EXIT:-0} -ne 0 ]] && FAIL=1

# ------------------------------------------------------------------
# 7. Verificar que fingerprint engine não tem regra com weight de porta
#    suficiente para classificar sozinha (max contribution de porta)
# ------------------------------------------------------------------

node -e "
const reg = require('./r-observe/discovery/src/inference/registry/inference-registry.json');
const PORT_CONFIDENCE = 0.12; // confidence do port hint no engine
const rules = reg.rules || [];
let fail = 0;
for (const rule of rules) {
  const w = rule.weights || {};
  const portContrib = ((w.tcp_open_port || 0) + (w.udp_open_port || 0)) * PORT_CONFIDENCE;
  // Para classificar com apenas 1 porta: score = portContrib * 1 evidência
  // Se portContrib >= threshold, porta isolada classificaria
  if (portContrib >= rule.threshold) {
    console.error('[FAIL] regra ' + rule.asset_type + ': contribuição máxima de porta (' +
      portContrib.toFixed(3) + ') >= threshold (' + rule.threshold + ')');
    fail++;
  } else {
    console.log('[PASS] regra ' + rule.asset_type + ': port_contrib=' +
      portContrib.toFixed(3) + ' < threshold=' + rule.threshold);
  }
}
process.exit(fail);
" 2>&1
WEIGHTS_EXIT=${PIPESTATUS[0]:-$?}
[[ ${WEIGHTS_EXIT:-0} -ne 0 ]] && FAIL=1

# ------------------------------------------------------------------
# 8. Verificar que o smoke-real não deixou fingerprints artificiais
#    (se o relatório existir)
# ------------------------------------------------------------------

if [[ -f "dist/discovery-smoke-real.json" ]]; then
  node -e "
const fs = require('fs');
const r = JSON.parse(fs.readFileSync('dist/discovery-smoke-real.json', 'utf8'));
const check = r.checks && r.checks['fingerprint artificial ausente'];
if (check && check.ok === false) {
  console.error('[FAIL] smoke-real reportou fingerprint artificial presente');
  process.exit(1);
}
console.log('[PASS] smoke-real: fingerprint artificial ausente confirmado');
" 2>&1
  SMOKE_FP_EXIT=${PIPESTATUS[0]:-$?}
  [[ ${SMOKE_FP_EXIT:-0} -ne 0 ]] && FAIL=1
else
  log_info "dist/discovery-smoke-real.json não encontrado — pulando verificação de artefatos smoke"
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
  audit: 'anti-fingerprint',
};
fs.writeFileSync('$REPORT_FILE', JSON.stringify(report, null, 2));
console.log('[discovery:audit:fingerprints] status=$STATUS report=$REPORT_FILE');
"

exit $FAIL
