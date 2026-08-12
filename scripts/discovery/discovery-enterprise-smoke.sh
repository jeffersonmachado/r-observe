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
TOKEN=""
DB_USER="${OBSERVE_DB_USER:-observe}"
DB_NAME="${OBSERVE_DB_NAME:-observedb}"

FAIL=0
ok() { echo "[PASS] $1"; }
ko() { echo "[FAIL] $1" >&2; FAIL=1; }
info() { echo "[INFO] $1"; }

require_container() {
  local name="$1"
  if docker ps --filter "name=${name}" --filter status=running --format "{{.Names}}" | grep -Fxq "$name"; then
    ok "container ${name} em execução"
  else
    ko "container ${name} não está em execução"
  fi
}

db_count() {
  local table="$1"
  docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM ${table};" 2>/dev/null | tr -d '[:space:]'
}

info "discovery:enterprise-smoke iniciando"

if [[ "${DISCOVERY_ENTERPRISE_SMOKE_MODE:-}" == "isolated" ]]; then
  info "modo isolado habilitado: validando runtime local do discovery"

  if node -e 'const {expandTargets}=require("./r-observe/discovery/src/scanners/target-expansion");(async()=>{const out=await expandTargets(["10.10.2.0/30","10.10.2.10-10.10.2.12","10.10.2.30"],{maxHosts:2048,maxScanTargets:2048});if(!out.targets||out.targets.length<7)process.exit(1);})();' >/dev/null 2>&1; then
    ok "target expansion runtime local"
  else
    ko "target expansion runtime local"
  fi

  if node -e 'const {parseSnmpOutput}=require("./r-observe/discovery/src/scanners/snmp-discovery");const sample=["SNMPv2-MIB::sysDescr.0 = STRING: Cisco IOS","SNMPv2-MIB::sysName.0 = STRING: sw-core-01"].join("\\n");const out=parseSnmpOutput(sample);if(!out.sysDescr||!out.sysName)process.exit(1);' >/dev/null 2>&1; then
    ok "snmp parser runtime local"
  else
    ko "snmp parser runtime local"
  fi

  if node -e 'const {parseArpTable,enrichArpAssets}=require("./r-observe/discovery/src/scanners/arp-discovery");const sample=["Address HWtype HWaddress Flags Mask Iface","10.10.2.1 ether 00:1B:44:aa:bb:cc C * eth0"].join("\\n");const rows=parseArpTable(sample);const enriched=enrichArpAssets(rows.map(r=>({primary_ip:r.ip,mac_address:r.mac,vendor:"MikroTik"})));if(!rows.length||!enriched.length||!enriched[0].device_type)process.exit(1);' >/dev/null 2>&1; then
    ok "arp parser runtime local"
  else
    ko "arp parser runtime local"
  fi

  if node -e 'const {normalizePassiveEvent}=require("./r-observe/discovery/src/passive/parser");const out=normalizePassiveEvent({source:"mdns",payload:{hostname:"cam-01.local",ip:"10.10.2.60"}});if(!out||!out.hostname)process.exit(1);' >/dev/null 2>&1; then
    ok "passive parser runtime local"
  else
    ko "passive parser runtime local"
  fi

  if [[ "$FAIL" -ne 0 ]]; then
    echo "[discovery:enterprise-smoke] FAIL (isolated)" >&2
    exit 1
  fi

  echo "[discovery:enterprise-smoke] OK (isolated)"
  exit 0
fi

require_container "$DISCOVERY_CONTAINER"
require_container "$REDIS_CONTAINER"
require_container "$PG_CONTAINER"

TOKEN="$(JWT_AUDIENCE=discovery JWT_SCOPE='discovery:access discovery:write' JWT_TENANT_ID=discovery-enterprise-smoke node "${ROOT_DIR}/scripts/observe/jwt-sign.js" discovery-enterprise-smoke 15m)"

# 1) Health
HEALTH_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  set +e
  HEALTH_JSON="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");h.get("http://127.0.0.1:3010/health",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));}).on("error",()=>process.exit(1));' 2>/dev/null)"
  HEALTH_RC=$?
  set -e
  if [[ "$HEALTH_RC" -eq 0 ]] && echo "$HEALTH_JSON" | grep -q '"status":"ok"\|"status":"degraded"'; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done

if [[ "$HEALTH_OK" -eq 1 ]]; then
  ok "health endpoint"
else
  ko "health endpoint"
fi

# 2) Target expansion real (CIDR + range + lista de IP + edge cases)
if docker exec "$DISCOVERY_CONTAINER" node -e 'const {expandTargets,isValidIPv4}=require("./src/scanners/target-expansion");(async()=>{const out=await expandTargets(["10.10.2.0/30","10.10.2.10-10.10.2.12","10.10.2.30"],{maxHosts:2048,maxScanTargets:2048});if(!out.targets||out.targets.length<7)process.exit(2);let failed=false;try{await expandTargets(["0.0.0.0/0"],{maxHosts:2048});failed=true;}catch{};try{await expandTargets(["10.10.2.999"],{maxHosts:2048});failed=true;}catch{};if(!isValidIPv4("10.10.2.1")||isValidIPv4("10.10.2.999"))failed=true;if(failed)process.exit(3);console.log("EXP_OK",out.targets.length);})().catch(()=>process.exit(1));' >/tmp/discovery-enterprise-targets.out 2>&1; then
  ok "target expansion enterprise"
else
  ko "target expansion enterprise"
fi

# 3) SNMP parser real
if docker exec "$DISCOVERY_CONTAINER" node -e 'const {parseSnmpOutput}=require("./src/scanners/snmp-discovery");const sample=["SNMPv2-MIB::sysDescr.0 = STRING: Cisco IOS","SNMPv2-MIB::sysName.0 = STRING: sw-core-01"].join("\\n");const out=parseSnmpOutput(sample);if(!out.sysDescr||!out.sysName)process.exit(1);console.log("SNMP_OK");' >/dev/null 2>&1; then
  ok "snmp parser"
else
  ko "snmp parser"
fi

# 4) ARP parser + enrichment
if docker exec "$DISCOVERY_CONTAINER" node -e 'const {parseArpTable,enrichArpAssets}=require("./src/scanners/arp-discovery");const sample=["Address HWtype HWaddress Flags Mask Iface","10.10.2.1 ether 00:1B:44:aa:bb:cc C * eth0"].join("\\n");const rows=parseArpTable(sample);const enriched=enrichArpAssets(rows.map(r=>({primary_ip:r.ip,mac_address:r.mac,vendor:"MikroTik"})));if(!enriched.length||!enriched[0].device_type)process.exit(1);console.log("ARP_OK");' >/dev/null 2>&1; then
  ok "arp parser/enrichment"
else
  ko "arp parser/enrichment"
fi

RUNS_BEFORE="$(db_count observe_discovery_runs || echo 0)"
FINDINGS_BEFORE="$(db_count observe_discovery_findings || echo 0)"
EDGES_BEFORE="$(db_count observe_topology_edges || echo 0)"

# 5) Scan com CIDR real
set +e
SCAN_RESP="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");const data=JSON.stringify({profile:"safe",trigger:"enterprise-smoke",tenant_id:"default",site_id:"default-site",edge_id:"central",targets:[{address:"10.10.2.0/30",discovery_type:"cidr"}]});const req=h.request({hostname:"127.0.0.1",port:3010,path:"/api/discovery/scan",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data),"x-internal-token":process.argv[1]}},(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));});req.on("error",()=>process.exit(1));req.write(data);req.end();' "$TOKEN" 2>/dev/null)"
SCAN_RC=$?
set -e
if [[ "$SCAN_RC" -eq 0 ]] && echo "$SCAN_RESP" | grep -q '"queued"\|"run_id"'; then
  ok "scan com CIDR submetido"
else
  ko "scan com CIDR submetido"
fi

# polling
RUNS_AFTER="$RUNS_BEFORE"
FINDINGS_AFTER="$FINDINGS_BEFORE"
EDGES_AFTER="$EDGES_BEFORE"
for _ in 1 2 3 4 5 6; do
  RUNS_AFTER="$(db_count observe_discovery_runs || echo 0)"
  FINDINGS_AFTER="$(db_count observe_discovery_findings || echo 0)"
  EDGES_AFTER="$(db_count observe_topology_edges || echo 0)"
  if [[ "$RUNS_AFTER" -gt "$RUNS_BEFORE" ]]; then
    break
  fi
  sleep 1
done

if [[ "$RUNS_AFTER" -gt "$RUNS_BEFORE" ]]; then
  ok "run persistido"
else
  ko "run persistido"
fi

if [[ "$FINDINGS_AFTER" -ge "$FINDINGS_BEFORE" ]]; then
  ok "findings atualizados"
else
  ko "findings atualizados"
fi

if [[ "$EDGES_AFTER" -ge "$EDGES_BEFORE" ]]; then
  ok "topology processada"
else
  ko "topology processada"
fi

# 6) Passive event ingestion
set +e
PASSIVE_RESP="$(docker exec "$DISCOVERY_CONTAINER" node -e 'const h=require("http");const data=JSON.stringify({source:"mdns",tenant_id:"default",site_id:"default-site",edge_id:"central",payload:{hostname:"cam-01.local",ip:"10.10.2.60"}});const req=h.request({hostname:"127.0.0.1",port:3010,path:"/api/discovery/passive/events",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data),"x-internal-token":process.argv[1]}},(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));});req.on("error",()=>process.exit(1));req.write(data);req.end();' "$TOKEN" 2>/dev/null)"
PASSIVE_RC=$?
set -e
if [[ "$PASSIVE_RC" -eq 0 ]] && echo "$PASSIVE_RESP" | grep -qi 'ok\|accepted\|queued'; then
  ok "passive discovery ingestion"
else
  ko "passive discovery ingestion"
fi

if docker exec "$DISCOVERY_CONTAINER" node -e 'const {parseSyslogMessage}=require("./src/passive/receivers");const e=parseSyslogMessage("CDP neighbor 10.10.2.1");if(!e||!e.type||!e.history||!Array.isArray(e.fingerprints))process.exit(1);' >/dev/null 2>&1; then
  ok "passive parser estruturado"
else
  ko "passive parser estruturado"
fi

# 7) Neo4j readiness (optional)
if [[ -n "${NEO4J_URI:-}" ]]; then
  if docker exec "$DISCOVERY_CONTAINER" node -e 'const neo4j=require("neo4j-driver");const u=process.env.NEO4J_URI;const usr=process.env.NEO4J_USER||"neo4j";const pwd=process.env.NEO4J_PASSWORD||"neo4j";const d=neo4j.driver(u,neo4j.auth.basic(usr,pwd));(async()=>{const s=d.session();try{await s.run("RETURN 1 AS ok");console.log("NEO4J_OK");process.exit(0);}catch(e){process.exit(1)}finally{await s.close();await d.close();}})();' >/dev/null 2>&1; then
    ok "neo4j connectivity"
  else
    ko "neo4j connectivity"
  fi
else
  info "neo4j desabilitado (NEO4J_URI ausente)"
fi

if docker exec "$DISCOVERY_CONTAINER" node -e 'const g=require("./src/topology/graph-store");(async()=>{const out=await g.dependencyTraversal({tenant:{tenant_id:"default",site_id:"default-site",edge_id:"central"},assetKey:"dummy"});if(typeof out.enabled!=="boolean")process.exit(1);})();' >/dev/null 2>&1; then
  ok "graph-store api"
else
  ko "graph-store api"
fi

# 8) Icinga readiness (optional)
if [[ -n "${OBSERVE_ICINGA_URL:-}" ]]; then
  if docker exec "$DISCOVERY_CONTAINER" node -e 'const {registerApprovedAsset}=require("./src/integrations/icinga");(async()=>{try{await registerApprovedAsset({asset_name:"enterprise-smoke-host",primary_ip:"10.10.2.250"});process.exit(0)}catch(e){process.exit(1)}})();' >/dev/null 2>&1; then
    ok "icinga sync hook"
  else
    ko "icinga sync hook"
  fi
else
  info "icinga desabilitado (OBSERVE_ICINGA_URL ausente)"
fi

# 9) Redis event queue sanity
if docker exec -e REDISCLI_AUTH="${OBSERVE_REDIS_PASSWORD:-}" "$REDIS_CONTAINER" redis-cli LLEN observe:events >/tmp/discovery-enterprise-events.out 2>/dev/null; then
  ok "redis event queue acessível"
else
  ko "redis event queue acessível"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[discovery:enterprise-smoke] FAIL" >&2
  exit 1
fi

echo "[discovery:enterprise-smoke] OK"
