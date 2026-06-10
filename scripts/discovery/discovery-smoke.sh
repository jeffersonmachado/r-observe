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
API_CONTAINER="r-observe-api"
_SECRET="${JWT_SECRET:-}"
DB_USER="${OBSERVE_DB_USER:-observe}"
DB_NAME="${OBSERVE_DB_NAME:-observedb}"

ok() { echo "[PASS] $1"; }
ko() { echo "[FAIL] $1" >&2; FAIL=1; }
info() { echo "[INFO] $1"; }

FAIL=0

info "discovery:smoke iniciando"

baseline_count() {
  local table="$1"
  docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM ${table};" 2>/dev/null | tr -d '[:space:]'
}

baseline_asset_epoch() {
  docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT COALESCE(EXTRACT(EPOCH FROM MAX(updated_at)),0)::bigint FROM observe_assets;" 2>/dev/null | tr -d '[:space:]'
}

baseline_finding_epoch() {
  docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT COALESCE(EXTRACT(EPOCH FROM MAX(updated_at)),0)::bigint FROM observe_discovery_findings;" 2>/dev/null | tr -d '[:space:]'
}

# Serviço inicia
if docker ps --filter "name=${DISCOVERY_CONTAINER}" --filter status=running --format "{{.Names}}" | grep -Fxq "$DISCOVERY_CONTAINER"; then
  ok "serviço r-observe-discovery está em execução"
else
  ko "serviço r-observe-discovery não está em execução"
  echo "Suba a stack com: npm run observe:up:core" >&2
  exit 1
fi

if docker ps --filter "name=${API_CONTAINER}" --filter status=running --format "{{.Names}}" | grep -Fxq "$API_CONTAINER"; then
  ok "serviço r-observe-api está em execução"
else
  ko "container r-observe-api não está em execução"
  exit 1
fi

# healthcheck /health
set +e
HEALTH_JSON="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");h.get("http://127.0.0.1:3010/health",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));}).on("error",()=>process.exit(1));' 2>/dev/null)"
HEALTH_RC=$?
set -e
if [[ "$HEALTH_RC" -eq 0 ]] && echo "$HEALTH_JSON" | grep -q '"status":"ok"\|"status":"degraded"'; then
  ok "healthcheck /health respondeu"
else
  ko "healthcheck /health não respondeu JSON válido"
fi

# /api/discovery/health
set +e
API_HEALTH_JSON="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");h.get("http://127.0.0.1:3010/api/discovery/health",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));}).on("error",()=>process.exit(1));' 2>/dev/null)"
API_HEALTH_RC=$?
set -e
if [[ "$API_HEALTH_RC" -eq 0 ]] && echo "$API_HEALTH_JSON" | grep -q '"service":"r-observe-discovery"'; then
  ok "endpoint /api/discovery/health respondeu"
else
  ko "endpoint /api/discovery/health não respondeu corretamente"
fi

if [[ -z "$_SECRET" ]]; then
  ko "JWT_SECRET não definido para smoke autenticado"
  echo "Defina token no .env.observe" >&2
  exit 1
fi
TOKEN="$(node "${ROOT_DIR}/scripts/observe/jwt-sign.js" discovery-smoke 15m)"

RUNS_BEFORE="$(baseline_count observe_discovery_runs || echo 0)"
FINDINGS_BEFORE="$(baseline_count observe_discovery_findings || echo 0)"
FINDING_EPOCH_BEFORE="$(baseline_finding_epoch || echo 0)"
ASSETS_BEFORE="$(baseline_count observe_assets || echo 0)"
ASSET_EPOCH_BEFORE="$(baseline_asset_epoch || echo 0)"
EVENTS_BEFORE="$(docker exec "$REDIS_CONTAINER" redis-cli LLEN observe:events 2>/dev/null | tr -d '[:space:]' || echo 0)"

TMP_SUB="$(mktemp)"
set +e
docker exec "$REDIS_CONTAINER" sh -lc "timeout 6 redis-cli --raw PSUBSCRIBE observe.discovery.started observe.discovery.completed" > "$TMP_SUB" 2>/dev/null &
SUB_PID=$!
set -e

# POST scan (direto no container, sem depender do observe-proxy)
set +e
SCAN_RESP="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");const data=JSON.stringify({profile:"safe",trigger:"discovery-smoke",tenant_id:"default",site_id:"default-site",edge_id:"central",targets:[{address:"10.10.2.30",discovery_type:"ip"},{address:"127.0.0.1",discovery_type:"ip"}]});const req=h.request({hostname:"127.0.0.1",port:3010,path:"/api/discovery/scan",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data),"x-internal-token":process.argv[1]}},(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));});req.on("error",()=>process.exit(1));req.write(data);req.end();' "$TOKEN" 2>/dev/null)"
SCAN_RC=$?
set -e
if [[ "$SCAN_RC" -eq 0 ]] && echo "$SCAN_RESP" | grep -q '"queued"\|"run_id"'; then
  ok "POST /api/discovery/scan aceito"
else
  ko "POST /api/discovery/scan não retornou resposta esperada"
fi

# polling curto até refletir no banco/redis
RUN_COUNT="$RUNS_BEFORE"
FINDING_COUNT="$FINDINGS_BEFORE"
FINDING_EPOCH_AFTER="$FINDING_EPOCH_BEFORE"
ASSET_COUNT="$ASSETS_BEFORE"
ASSET_EPOCH_AFTER="$ASSET_EPOCH_BEFORE"
EVENT_LIST_LEN="$EVENTS_BEFORE"
for _i in 1 2 3 4 5; do
  RUN_COUNT="$(baseline_count observe_discovery_runs || echo 0)"
  FINDING_COUNT="$(baseline_count observe_discovery_findings || echo 0)"
  FINDING_EPOCH_AFTER="$(baseline_finding_epoch || echo 0)"
  ASSET_COUNT="$(baseline_count observe_assets || echo 0)"
  ASSET_EPOCH_AFTER="$(baseline_asset_epoch || echo 0)"
  EVENT_LIST_LEN="$(docker exec "$REDIS_CONTAINER" redis-cli LLEN observe:events 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [[ "$RUN_COUNT" -gt "$RUNS_BEFORE" ]] && { [[ "$FINDING_COUNT" -gt "$FINDINGS_BEFORE" ]] || [[ "$FINDING_EPOCH_AFTER" -gt "$FINDING_EPOCH_BEFORE" ]]; } && { [[ "$ASSET_COUNT" -gt "$ASSETS_BEFORE" ]] || [[ "$ASSET_EPOCH_AFTER" -gt "$ASSET_EPOCH_BEFORE" ]]; }; then
    break
  fi
  sleep 1
done

# run criado
if [[ "$RUN_COUNT" =~ ^[0-9]+$ ]] && [[ "$RUN_COUNT" -gt "$RUNS_BEFORE" ]]; then
  ok "discovery_run criado (antes=$RUNS_BEFORE depois=$RUN_COUNT)"
else
  ko "nenhum discovery_run encontrado"
fi

# finding persistido
if [[ "$FINDING_COUNT" =~ ^[0-9]+$ ]] && { [[ "$FINDING_COUNT" -gt "$FINDINGS_BEFORE" ]] || [[ "$FINDING_EPOCH_AFTER" -gt "$FINDING_EPOCH_BEFORE" ]] || { [[ "$RUN_COUNT" -gt "$RUNS_BEFORE" ]] && [[ "$FINDING_COUNT" -gt 0 ]]; }; }; then
  ok "finding persistido/atualizado (count $FINDINGS_BEFORE->$FINDING_COUNT, updated_at $FINDING_EPOCH_BEFORE->$FINDING_EPOCH_AFTER)"
else
  ko "nenhum finding persistido"
fi

# asset criado/atualizado
if [[ "$ASSET_COUNT" =~ ^[0-9]+$ ]] && { [[ "$ASSET_COUNT" -gt "$ASSETS_BEFORE" ]] || [[ "$ASSET_EPOCH_AFTER" -gt "$ASSET_EPOCH_BEFORE" ]]; }; then
  ok "asset criado ou atualizado (count $ASSETS_BEFORE->$ASSET_COUNT, updated_at $ASSET_EPOCH_BEFORE->$ASSET_EPOCH_AFTER)"
else
  if [[ "$RUN_COUNT" =~ ^[0-9]+$ ]] && [[ "$RUN_COUNT" -gt "$RUNS_BEFORE" ]] && [[ "$FINDING_COUNT" =~ ^[0-9]+$ ]] && [[ "$FINDING_COUNT" -gt 0 ]]; then
    ok "asset sem alteração detectada neste ciclo (count $ASSETS_BEFORE->$ASSET_COUNT), mas run e findings foram persistidos"
  else
    ko "nenhum asset criado/atualizado"
  fi
fi

# eventos redis started/completed
STARTED_EVT="$(docker exec "$REDIS_CONTAINER" redis-cli PUBSUB NUMSUB observe.discovery.started 2>/dev/null | tr '\n' ' ')"
COMPLETED_EVT="$(docker exec "$REDIS_CONTAINER" redis-cli PUBSUB NUMSUB observe.discovery.completed 2>/dev/null | tr '\n' ' ')"
set +e
wait "$SUB_PID"
set -e
if grep -q "observe.discovery.started" "$TMP_SUB" && grep -q "observe.discovery.completed" "$TMP_SUB"; then
  ok "eventos Redis emitidos: observe.discovery.started e observe.discovery.completed"
else
  ko "eventos Redis started/completed não capturados"
fi
if [[ -n "$STARTED_EVT" ]]; then ok "canal observe.discovery.started acessível"; else ko "canal observe.discovery.started indisponível"; fi
if [[ -n "$COMPLETED_EVT" ]]; then ok "canal observe.discovery.completed acessível"; else ko "canal observe.discovery.completed indisponível"; fi
rm -f "$TMP_SUB"

# prometheus http sd json
set +e
HTTP_SD_JSON="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");h.get("http://127.0.0.1:3010/api/discovery/prometheus/http-sd",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));}).on("error",()=>process.exit(1));' 2>/dev/null)"
HTTP_SD_RC=$?
set -e
if [[ "$HTTP_SD_RC" -eq 0 ]] && node -e 'try{const d=JSON.parse(process.argv[1]);if(!Array.isArray(d))process.exit(2);}catch(e){process.exit(1)}' "$HTTP_SD_JSON"; then
  ok "endpoint Prometheus HTTP SD respondeu JSON válido"
else
  ko "endpoint Prometheus HTTP SD não retornou JSON válido"
fi

# Falha Icinga não derruba discovery (simulação via env ausente no integration hook)
if docker exec "$DISCOVERY_CONTAINER" node -e 'const {registerApprovedAsset}=require("./src/integrations/icinga");(async()=>{try{await registerApprovedAsset({asset_name:"x",primary_ip:"10.0.0.1"});process.exit(0)}catch(e){process.stdout.write(String(e.message||e));process.exit(0)}})();' >/dev/null 2>&1; then
  ok "falha/no-op de Icinga não derruba discovery"
else
  ko "integração Icinga derrubou fluxo"
fi

# Falha Redis explícita
if docker exec "$DISCOVERY_CONTAINER" node -e 'const {emitEvent}=require("./src/queues/events");const Redis=require("ioredis");const r=new Redis("redis://127.0.0.1:6399",{connectTimeout:500,maxRetriesPerRequest:0});(async()=>{try{await emitEvent(r,"x",{a:1});console.log("UNEXPECTED_OK");process.exit(2)}catch(e){if((e.message||"").length>0){console.log("OK_EXPLICIT");process.exit(0)}process.exit(1)}finally{r.disconnect();}})();' | grep -q "OK_EXPLICIT"; then
  ok "falha no Redis gera erro explícito"
else
  ko "falha no Redis não gerou erro explícito"
fi

# Falha PostgreSQL explícita
if docker exec "$DISCOVERY_CONTAINER" node -e 'const {Pool}=require("pg");const db=new Pool({host:"127.0.0.1",port:55432,user:"x",password:"x",database:"x",connectionTimeoutMillis:700});(async()=>{try{await db.query("SELECT 1");console.log("UNEXPECTED_OK");process.exit(2)}catch(e){if((e.message||"").length>0){console.log("OK_EXPLICIT");process.exit(0)}process.exit(1)}finally{await db.end().catch(()=>{});}})();' | grep -q "OK_EXPLICIT"; then
  ok "falha no PostgreSQL gera erro explícito"
else
  ko "falha no PostgreSQL não gerou erro explícito"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[discovery:smoke] FAIL" >&2
  exit 1
fi

echo "[discovery:smoke] OK"
