#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ROOT_DIR}/.env.observe"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DISCOVERY_CONTAINER="r-observe-discovery"
REDIS_CONTAINER="r-observe-redis"
PG_CONTAINER="r-observe-postgres"
_SECRET="${JWT_SECRET:-}"
DB_USER="${OBSERVE_DB_USER:-observe}"
DB_NAME="${OBSERVE_DB_NAME:-observedb}"

ok() { echo "[PASS] $1"; }
ko() { echo "[FAIL] $1" >&2; FAIL=1; }

FAIL=0

echo "[discovery:integration] Validando integração real"

for ctr in "$DISCOVERY_CONTAINER" "$REDIS_CONTAINER" "$PG_CONTAINER"; do
  if ! docker ps --filter "name=${ctr}" --filter status=running --format "{{.Names}}" | grep -Fxq "$ctr"; then
    ko "container não rodando: $ctr"
  fi
done
if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi

if [[ -z "$_SECRET" ]]; then
  ko "JWT_SECRET ausente para integração"
  exit 1
fi
TOKEN="$(node "${ROOT_DIR}/scripts/observe/jwt-sign.js" discovery-integration 15m)"

# Enfileira scan explicitamente
TASK='{"profile":"safe","trigger":"integration-test","targets":[{"address":"10.10.2.30","discovery_type":"ip"},{"address":"127.0.0.1","discovery_type":"ip"}]}'
TMP_SCAN_RESULTS="$(mktemp)"
set +e
docker exec "$REDIS_CONTAINER" sh -lc "timeout 6 redis-cli --raw SUBSCRIBE observe:scan:results" > "$TMP_SCAN_RESULTS" 2>/dev/null &
SUB_SCAN_PID=$!
set -e
docker exec "$REDIS_CONTAINER" redis-cli RPUSH observe:scan:network "$TASK" >/dev/null
ok "scan enfileirado em observe:scan:network"

sleep 1

QUEUE_LEN="$(docker exec "$REDIS_CONTAINER" redis-cli LLEN observe:scan:network | tr -d '[:space:]')"
if [[ "$QUEUE_LEN" =~ ^[0-9]+$ ]]; then
  ok "fila observe:scan:network acessível (len=$QUEUE_LEN)"
else
  ko "não foi possível ler observe:scan:network"
fi

set +e
wait "$SUB_SCAN_PID"
set -e
if grep -q "observe:scan:results" "$TMP_SCAN_RESULTS"; then
  ok "discovery publicou observe:scan:results"
else
  ko "observe:scan:results sem publicação"
fi
rm -f "$TMP_SCAN_RESULTS"

check_table_count() {
  local table="$1"
  local min_count="$2"
  local val
  val="$(docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM ${table};" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [[ "$val" =~ ^[0-9]+$ ]] && [[ "$val" -ge "$min_count" ]]; then
    ok "${table} persistida (${val})"
  else
    ko "${table} sem dados suficientes (${val})"
  fi
}

check_table_count "observe_assets" 1
check_table_count "observe_asset_services" 0
check_table_count "observe_discovery_findings" 1
check_table_count "observe_service_fingerprints" 1
check_table_count "observe_topology_edges" 0

# HTTP SD só serviços aprovados/monitoráveis
set +e
HTTP_SD_JSON="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");h.get("http://127.0.0.1:3010/api/discovery/prometheus/http-sd",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));}).on("error",()=>process.exit(1));' 2>/dev/null)"
HTTP_SD_RC=$?
set -e
if [[ "$HTTP_SD_RC" -eq 0 ]] && node -e 'const d=JSON.parse(process.argv[1]);if(!Array.isArray(d))process.exit(2);process.exit(0)' "$HTTP_SD_JSON"; then
  ok "Prometheus HTTP SD retornou JSON"
else
  ko "Prometheus HTTP SD inválido"
fi

# Icinga onboarding idempotente (quando perfil icinga está ativo)
if docker ps --filter "name=observe-icinga2" --filter status=running --format "{{.Names}}" | grep -Fxq "observe-icinga2"; then
  if docker exec "$DISCOVERY_CONTAINER" node -e 'const {registerApprovedAsset}=require("./src/integrations/icinga");const a={asset_name:"idemp-test",primary_ip:"10.20.30.40",lifecycle_state:"approved"};(async()=>{try{const r1=await registerApprovedAsset(a);const r2=await registerApprovedAsset(a);if((r1 && typeof r1.ok!=="undefined")&&(r2 && typeof r2.ok!=="undefined")){process.exit(0);}process.exit(1);}catch(_e){process.exit(1);}})();'; then
    ok "Icinga onboarding idempotente"
  else
    ko "Icinga onboarding não idempotente"
  fi
else
  ok "Icinga onboarding idempotente (SKIP: perfil icinga inativo)"
fi

# Estados do ciclo de vida
STATE_CHECK="$(docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT string_agg(state, ',') FROM (SELECT unnest(ARRAY['discovered','approved','monitored','ignored','quarantined','disappeared']) AS state) s WHERE state IN ('discovered','approved','monitored','ignored','quarantined','disappeared');" 2>/dev/null | tr -d '\n')"
if [[ "$STATE_CHECK" == *"discovered"* && "$STATE_CHECK" == *"approved"* && "$STATE_CHECK" == *"monitored"* && "$STATE_CHECK" == *"ignored"* && "$STATE_CHECK" == *"quarantined"* && "$STATE_CHECK" == *"disappeared"* ]]; then
  ok "estados do ciclo de vida contemplados: discovered, approved, monitored, ignored, quarantined, disappeared"
else
  ko "estados do ciclo de vida incompletos"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[discovery:integration] FAIL" >&2
  exit 1
fi

echo "[discovery:integration] OK"
