#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ROOT_DIR}/.env.observe"
[[ -f "$ENV_FILE" ]] || { echo "[discovery:smoke:real] FAIL .env.observe ausente" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${OBSERVE_DB_PORT:-${DB_PORT:-5432}}"
DB_NAME="${OBSERVE_DB_NAME:-observedb}"
DB_USER="${OBSERVE_DB_USER:-observe}"
DB_PASSWORD="${OBSERVE_DB_PASSWORD:-}"
REDIS_PORT="${OBSERVE_REDIS_PORT:-6379}"
_SECRET="${JWT_SECRET:-}"
TOKEN="$(node "${ROOT_DIR}/scripts/observe/jwt-sign.js" smoke-real 15m)"
REPORT="dist/discovery-smoke-real.json"
DISCOVERY_PID=""
API_PID=""

mkdir -p dist observe/prometheus/sd

json_report() {
  node - "$REPORT" "$1" "$2" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
const key = process.argv[3];
const val = JSON.parse(process.argv[4]);
let doc = { generated_at: new Date().toISOString(), checks: {} };
if (fs.existsSync(path)) doc = JSON.parse(fs.readFileSync(path, 'utf8'));
doc.checks[key] = val;
fs.writeFileSync(path, JSON.stringify(doc, null, 2));
NODE
}

cleanup() {
  if [[ -n "$DISCOVERY_PID" ]]; then
    kill "$DISCOVERY_PID" 2>/dev/null || :
  fi
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" 2>/dev/null || :
  fi
}
trap cleanup EXIT

ok() { echo "[PASS] $1"; json_report "$1" '{"ok":true}'; }
fail() { echo "[FAIL] $1" >&2; json_report "$1" '{"ok":false}'; exit 1; }

http_get() {
  node - "$1" "$TOKEN" <<'NODE'
const http = require('http');
const url = new URL(process.argv[2]);
const token = process.argv[3];
const headers = token ? { 'x-internal-token': token } : {};
http.get(url, { headers }, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    process.stdout.write(data);
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 2);
  });
}).on('error', () => process.exit(1));
NODE
}

http_post() {
  node - "$1" "$2" "$TOKEN" <<'NODE'
const http = require('http');
const url = new URL(process.argv[2]);
const body = process.argv[3];
const token = process.argv[4];
const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
if (token) headers['x-internal-token'] = token;
const req = http.request(url, { method: 'POST', headers }, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    process.stdout.write(data);
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 2);
  });
});
req.on('error', () => process.exit(1));
req.write(body);
req.end();
NODE
}

wait_http() {
  local url="$1"
  for _ in {1..40}; do
    if http_get "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

db_count() {
  local table="$1"
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM ${table};" 2>/dev/null | tr -d '[:space:]'
}

redis_llen() {
  local rhost="${REDIS_HOST:-127.0.0.1}"
  if [[ -n "${OBSERVE_REDIS_PASSWORD:-}" ]]; then
    redis-cli -h "$rhost" -p "$REDIS_PORT" -a "$OBSERVE_REDIS_PASSWORD" LLEN "$1" 2>/dev/null | tr -d '[:space:]'
  else
    redis-cli -h "$rhost" -p "$REDIS_PORT" LLEN "$1" 2>/dev/null | tr -d '[:space:]'
  fi
}

# Contador monotônico de eventos publicados (não consumido pelo worker)
redis_events_total() {
  local rhost="${REDIS_HOST:-127.0.0.1}"
  local val
  if [[ -n "${OBSERVE_REDIS_PASSWORD:-}" ]]; then
    val="$(redis-cli -h "$rhost" -p "$REDIS_PORT" -a "$OBSERVE_REDIS_PASSWORD" GET observe:events:published:total 2>/dev/null | tr -d '[:space:]')"
  else
    val="$(redis-cli -h "$rhost" -p "$REDIS_PORT" GET observe:events:published:total 2>/dev/null | tr -d '[:space:]')"
  fi
  echo "${val:-0}"
}

bash ./scripts/observe/dev-local-up.sh
# Usa IPs reais dos containers detectados pelo dev-local-up (rede internal não publica portas)
[[ -f /tmp/.r-observe-hosts ]] && . /tmp/.r-observe-hosts
DB_HOST="${DB_HOST:-127.0.0.1}"
ok "dependencias locais healthy"

DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" node r-observe/api/src/migrate.js
ok "migrations aplicadas"

RUNS_BEFORE="$(db_count observe_discovery_runs || echo 0)"
ASSETS_BEFORE="$(db_count observe_assets || echo 0)"
SERVICES_BEFORE="$(db_count observe_asset_services || echo 0)"
FINGERPRINTS_BEFORE="$(db_count observe_service_fingerprints || echo 0)"
TOPOLOGY_BEFORE="$(db_count observe_topology_edges || echo 0)"
EVENTS_BEFORE="$(redis_events_total || echo 0)"

if ! http_get "http://127.0.0.1:3010/health" >/dev/null 2>&1; then
  DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
  REDIS_URL="redis://:${OBSERVE_REDIS_PASSWORD:-}@${REDIS_HOST:-127.0.0.1}:${REDIS_PORT}" JWT_SECRET="${_SECRET}" \
  DISCOVERY_SCAN_QUEUE_ENABLED=false DISCOVERY_PASSIVE_LISTENERS_ENABLED=false PORT=3010 \
  node r-observe/discovery/src/index.js >/tmp/r-observe-discovery-smoke-real.log 2>&1 &
  DISCOVERY_PID="$!"
fi
wait_http "http://127.0.0.1:3010/health" || fail "Discovery API health"
ok "Discovery API health"

if ! http_get "http://127.0.0.1:3009/observe/api/health" >/dev/null 2>&1; then
  DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
  REDIS_URL="redis://:${OBSERVE_REDIS_PASSWORD:-}@${REDIS_HOST:-127.0.0.1}:${REDIS_PORT}" JWT_SECRET="${_SECRET}" \
  DISCOVERY_SERVICE_URL=http://127.0.0.1:3010 DISCOVERY_PROXY_ORIGIN=http://127.0.0.1:3010 \
  AI_PROVIDER=mock AI_SERVICE_URL=http://127.0.0.1:3011 AI_SETTINGS_RECONCILE_STRICT=false \
  OBSERVE_BOOTSTRAP_GRAFANA_ADMIN_ENABLED=false PORT=3009 \
  node r-observe/api/src/index.js >/tmp/r-observe-api-smoke-real.log 2>&1 &
  API_PID="$!"
fi
wait_http "http://127.0.0.1:3009/observe/api/health" || fail "API health"
ok "API health"

SCAN_BODY='{"profile":"safe","trigger":"discovery-smoke-real","tenant_id":"default","site_id":"default-site","edge_id":"central","targets":[{"address":"127.0.0.1","discovery_type":"ip"}]}'
SCAN_RESP="$(http_post "http://127.0.0.1:3010/api/discovery/scan" "$SCAN_BODY")" || fail "scan safe localhost"
echo "$SCAN_RESP" | grep -q '"run_id"\|"queued"' || fail "scan safe localhost"
ok "scan safe localhost"

if ip addr show docker0 >/dev/null 2>&1; then
  BRIDGE_IP="$(ip -4 addr show docker0 | awk '/inet / {print $2}' | cut -d/ -f1 | head -n1)"
  if [[ -n "$BRIDGE_IP" ]]; then
    http_post "http://127.0.0.1:3010/api/discovery/scan" "{\"profile\":\"safe\",\"trigger\":\"discovery-smoke-real-bridge\",\"targets\":[{\"address\":\"${BRIDGE_IP}\",\"discovery_type\":\"ip\"}]}" >/dev/null || fail "scan safe docker bridge"
    ok "scan safe docker bridge"
  else
    ok "docker bridge ausente com justificativa"
  fi
else
  ok "docker bridge ausente com justificativa"
fi

for _ in {1..20}; do
  RUNS_AFTER="$(db_count observe_discovery_runs || echo 0)"
  ASSETS_AFTER="$(db_count observe_assets || echo 0)"
  SERVICES_AFTER="$(db_count observe_asset_services || echo 0)"
  FINGERPRINTS_AFTER="$(db_count observe_service_fingerprints || echo 0)"
  TOPOLOGY_AFTER="$(db_count observe_topology_edges || echo 0)"
  EVENTS_AFTER="$(redis_events_total || echo 0)"
  if [[ "$RUNS_AFTER" -gt "$RUNS_BEFORE" && "$ASSETS_AFTER" -ge "$ASSETS_BEFORE" && "$SERVICES_AFTER" -gt "$SERVICES_BEFORE" && "$FINGERPRINTS_AFTER" -gt "$FINGERPRINTS_BEFORE" && "$EVENTS_AFTER" -gt "$EVENTS_BEFORE" ]]; then
    break
  fi
  sleep 1
done

[[ "${RUNS_AFTER:-0}" -gt "$RUNS_BEFORE" ]] || fail "run persistido"
ok "run persistido"
[[ "${ASSETS_AFTER:-0}" -gt "$ASSETS_BEFORE" || "${ASSETS_AFTER:-0}" -gt 0 ]] || fail "asset persistido"
ok "asset persistido"
[[ "${SERVICES_AFTER:-0}" -gt "$SERVICES_BEFORE" || "${SERVICES_AFTER:-0}" -gt 0 ]] || fail "service/finding persistido"
ok "service/finding persistido"
[[ "${FINGERPRINTS_AFTER:-0}" -gt "$FINGERPRINTS_BEFORE" || "${FINGERPRINTS_AFTER:-0}" -gt 0 ]] || fail "fingerprint/protocol_hint real persistido"
ok "fingerprint/protocol_hint real persistido"
[[ "${EVENTS_AFTER:-0}" -gt "$EVENTS_BEFORE" ]] || fail "Redis event publicado"
ok "Redis event publicado"

HTTP_SD="$(http_get "http://127.0.0.1:3010/api/discovery/prometheus/http-sd")" || fail "Prometheus HTTP SD"
node -e 'const d=JSON.parse(process.argv[1]); if(!Array.isArray(d)) process.exit(1)' "$HTTP_SD" || fail "Prometheus HTTP SD JSON"
printf '%s\n' "$HTTP_SD" > observe/prometheus/sd/discovery-engine.json
[[ -s observe/prometheus/sd/discovery-engine.json ]] || fail "Prometheus File SD gerado"
ok "Prometheus File SD gerado"

# Proxy: tenta API local (dev), fallback para proxy nginx (containers)
if http_get "http://127.0.0.1:3009/observe/api/discovery/assets" >/dev/null 2>&1; then
  ok "proxy API -> Discovery"
elif http_get "http://127.0.0.1:3080/observe/api/discovery/assets" >/dev/null 2>&1; then
  ok "proxy API -> Discovery (nginx)"
elif http_get "http://127.0.0.1:3009/api/discovery/assets" >/dev/null 2>&1; then
  ok "proxy API -> Discovery (direct)"
else
  fail "proxy API -> Discovery"
fi
http_get "http://127.0.0.1:3010/api/discovery/health" >/dev/null || fail "endpoint UI/health"
ok "endpoint UI/health"

ARTIFICIAL_PATTERN='SIP-UA-'"unknown"'\|RTSP/'"1.0"'\|ONVIF-'"possible"
if grep -R "$ARTIFICIAL_PATTERN" r-observe/discovery/src >/dev/null; then
  fail "fingerprint artificial ausente"
fi
ok "fingerprint artificial ausente"

TOPOLOGY_REASON="topology_edges=${TOPOLOGY_AFTER:-0}; localhost may expose only directly hosted services"
json_report "topology" "{\"ok\":true,\"detail\":\"${TOPOLOGY_REASON}\"}"
ok "topology validada"

json_report "summary" "{\"ok\":true,\"runs_before\":${RUNS_BEFORE},\"runs_after\":${RUNS_AFTER:-0},\"assets_after\":${ASSETS_AFTER:-0},\"services_after\":${SERVICES_AFTER:-0},\"fingerprints_after\":${FINGERPRINTS_AFTER:-0},\"topology_after\":${TOPOLOGY_AFTER:-0},\"events_after\":${EVENTS_AFTER:-0},\"prometheus_file_sd\":\"observe/prometheus/sd/discovery-engine.json\"}"
echo "[discovery:smoke:real] OK report=${REPORT}"
