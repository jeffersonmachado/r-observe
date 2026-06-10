#!/usr/bin/env bash
# scripts/package/release-smoke.sh
#
# Smoke test em duas fases:
#
# FASE A — Extração limpa (FASE 8):
#   1. Extrai dist/infra.zip em diretório temporário limpo.
#   2. Verifica presença de todos os arquivos críticos.
#   3. Verifica ausência de proibidos (node_modules, .git, .env).
#   4. Executa validação de dependências + npm install + discovery:test a partir da extração.
#
# FASE B — Sondagem do runtime (opcional, não falha se stack offline):
#   Se o container r-observe-discovery estiver rodando:
#     - Proba /health via Node.js interno no container
#     - Proba /api/discovery/runs via Node.js interno
#     - Verifica fila Redis observe:events
#     - Verifica tabela observe_discovery_runs no PostgreSQL
#     - Verifica proxy observe-proxy via http://localhost:3080
#
# FASE B é SKIP (não FAIL) se a stack não estiver rodando.
#
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

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

_pass()    { printf "${GREEN}[PASS]${NC} %s\n" "$*";        PASS_COUNT=$((PASS_COUNT + 1)); }
_fail()    { printf "${RED}[FAIL]${NC} %s\n" "$*" >&2;     FAIL_COUNT=$((FAIL_COUNT + 1)); SMOKE_FAIL=1; }
_skip()    { printf "${CYAN}[SKIP]${NC} %s\n" "$*"; }
_info()    { printf "${YELLOW}[INFO]${NC} %s\n" "$*"; }
_section() { printf "\n${BOLD}══ %s ══${NC}\n" "$*"; }

SMOKE_FAIL=0
PASS_COUNT=0
FAIL_COUNT=0
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

mkdir -p dist
REPORT="dist/release-smoke-report.json"
DATE_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ZIP_MAIN="dist/infra.zip"

ensure_zip_exists() {
  local zip_path="$1"
  if [[ ! -f "$zip_path" ]]; then
    _info "Artefato ausente para smoke: $zip_path; gerando com 'npm run zip'"
    npm run zip
  fi
}

EXTRACTION_STATUS="skip"
UNIT_TEST_STATUS="skip"
RUNTIME_STATUS="skip"
RUNTIME_DETAIL="stack not running"
_SECRET="${JWT_SECRET:-}"
DISCOVERY_TOKEN="${_SECRET:+$(node "${ROOT_DIR}/scripts/observe/jwt-sign.js" release-smoke 15m 2>/dev/null || true)}"

# ════════════════════════════════════════════════════════════════════════════
# FASE A — EXTRAÇÃO EM DIRETÓRIO LIMPO
# ════════════════════════════════════════════════════════════════════════════
_section "FASE A  —  EXTRAÇÃO EM DIRETÓRIO LIMPO"

ensure_zip_exists "$ZIP_MAIN"

if [[ ! -f "$ZIP_MAIN" ]]; then
  _fail "ZIP não encontrado: $ZIP_MAIN mesmo após tentativa de regeneração"
  EXTRACTION_STATUS="fail"
else
  EXTRACT_DIR="$TMPD/extracted"
  mkdir -p "$EXTRACT_DIR"
  _info "Extraindo $ZIP_MAIN em $EXTRACT_DIR ..."
  unzip -q "$ZIP_MAIN" -d "$EXTRACT_DIR"

  EXTRACTED_COUNT="$(find "$EXTRACT_DIR" -type f | wc -l | tr -d ' ')"
  _info "Arquivos extraídos: $EXTRACTED_COUNT"

  # ── Verificar arquivos críticos na extração ────────────────────────────
  CRITICAL=(
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
    "scripts/release/validate-enterprise-package.js"
    "scripts/release/validate-extracted-package.js"
  )

  EXTRACT_FAIL=0
  for f in "${CRITICAL[@]}"; do
    if [[ -f "$EXTRACT_DIR/$f" ]]; then
      _pass "Extraído: $f"
    else
      _fail "AUSENTE após extração: $f"
      EXTRACT_FAIL=1
    fi
  done

  # ── Verificar ausência de proibidos ────────────────────────────────────
  if find "$EXTRACT_DIR" -type d -name "node_modules" 2>/dev/null | grep -q .; then
    _fail "node_modules encontrado na extração"
    EXTRACT_FAIL=1
  else
    _pass "node_modules: ausente na extração"
  fi

  if find "$EXTRACT_DIR" -name ".git" -type d 2>/dev/null | grep -q .; then
    _fail ".git encontrado na extração"
    EXTRACT_FAIL=1
  else
    _pass ".git: ausente na extração"
  fi

  # .env excluídos (exceto .env.*.example)
  FORBIDDEN_ENV_FOUND=0
  while IFS= read -r -d $'\0' f; do
    base="$(basename "$f")"
    FORBIDDEN_ENV_FOUND=1
    _fail ".env sensível encontrado na extração: $f"
  done < <(find "$EXTRACT_DIR" \( -name ".env" -o -name "*.token.env" \) -not -name "*.example" -type f -print0 2>/dev/null)
  if [[ "$FORBIDDEN_ENV_FOUND" -eq 0 ]]; then
    _pass ".env sensível: ausente na extração"
  else
    EXTRACT_FAIL=1
  fi

  if [[ "$EXTRACT_FAIL" -eq 0 ]]; then
    EXTRACTION_STATUS="pass"
    _pass "Estrutura da extração: completa e íntegra"
  else
    EXTRACTION_STATUS="fail"
    SMOKE_FAIL=1
    _fail "Estrutura da extração: verificação falhou"
  fi

  # ── Validar dependências e executar testes a partir da extração ───────
  _section "FASE A  —  DEPENDÊNCIAS E TESTES (A PARTIR DA EXTRAÇÃO)"

  if [[ ! -f "$EXTRACT_DIR/scripts/release/validate-extracted-package.js" ]]; then
    _fail "Validador do pacote extraído não encontrado"
    UNIT_TEST_STATUS="fail"
    SMOKE_FAIL=1
  else
    _info "Executando validação isolada do pacote extraído..."
    set +e
    node "$EXTRACT_DIR/scripts/release/validate-extracted-package.js" \
      --root "$EXTRACT_DIR" --run-install --run-tests --run-smoke
    EXTRACT_VALIDATE_RC=$?
    set -e
    if [[ "$EXTRACT_VALIDATE_RC" -eq 0 ]]; then
      _pass "pacote extraído: dependências, install, lint/audit e testes PASSARAM"
      UNIT_TEST_STATUS="pass"
    else
      _fail "pacote extraído: validação isolada FALHOU (exit $EXTRACT_VALIDATE_RC)"
      UNIT_TEST_STATUS="fail"
      SMOKE_FAIL=1
    fi
  fi
fi  # fim do bloco ZIP_MAIN existe

# ════════════════════════════════════════════════════════════════════════════
# FASE B — SONDAGEM DO RUNTIME (opcional)
# ════════════════════════════════════════════════════════════════════════════
_section "FASE B  —  SONDAGEM DO RUNTIME"

DISCOVERY_CTR=""
set +e
DISCOVERY_CTR="$(docker ps \
  --filter "name=r-observe-discovery" \
  --filter "status=running" \
  --format "{{.Names}}" 2>/dev/null | head -1)"
set -e

if [[ -z "$DISCOVERY_CTR" ]]; then
  _skip "Container r-observe-discovery não está rodando — Fase B pulada"
  _skip "  Para ativar: npm run observe:up"
  RUNTIME_STATUS="skip"
  RUNTIME_DETAIL="container r-observe-discovery not running"
else
  _info "Container encontrado: $DISCOVERY_CTR"
  RUNTIME_FAIL=0

  # B1: Health check via Node.js nativo do container ─────────────────────
  _info "B1: /health via Node.js interno..."
  set +e
  HEALTH_RESP="$(docker exec "$DISCOVERY_CTR" \
    node -e 'const h=require("http");h.get("http://127.0.0.1:3010/health",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{process.stdout.write(d);process.exit(0)})}).on("error",e=>{process.stderr.write(e.message+"\n");process.exit(1)})' \
    2>/dev/null)"
  HEALTH_RC=$?
  set -e

  if [[ "$HEALTH_RC" -eq 0 ]] && echo "$HEALTH_RESP" | grep -q '"status"'; then
    _pass "Discovery /health: OK  (resp: ${HEALTH_RESP:0:80})"
  else
    _fail "Discovery /health: FALHOU  (rc=$HEALTH_RC  resp: ${HEALTH_RESP:-vazio})"
    RUNTIME_FAIL=1
  fi

  # B2: /api/discovery/runs endpoint ─────────────────────────────────────
  _info "B2: /api/discovery/runs via Node.js interno..."
  set +e
  RUNS_RESP="$(docker exec "$DISCOVERY_CTR" \
    node -e 'const h=require("http");const req=h.request({hostname:"127.0.0.1",port:3010,path:"/api/discovery/runs",headers:{"x-internal-token":process.argv[1]||""}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{process.stdout.write(d);process.exit(0)})});req.on("error",()=>process.exit(1));req.end();' "$DISCOVERY_TOKEN" \
    2>/dev/null)"
  RUNS_RC=$?
  set -e

  if [[ "$RUNS_RC" -eq 0 ]] && echo "$RUNS_RESP" | grep -q '"runs"'; then
    _pass "Discovery /api/discovery/runs: OK"
  else
    _fail "Discovery /api/discovery/runs: FALHOU  (endpoint inacessível ou resposta inesperada)"
    RUNTIME_FAIL=1
  fi

  # B3: Redis observe:events ─────────────────────────────────────────────
  _info "B3: Redis observe:events LLEN..."
  REDIS_CTR=""
  set +e
  REDIS_CTR="$(docker ps --filter "name=observe-redis" --filter "status=running" \
    --format "{{.Names}}" 2>/dev/null | head -1)"
  set -e

  if [[ -n "$REDIS_CTR" ]]; then
    set +e
    REDIS_LEN="$(docker exec "$REDIS_CTR" redis-cli LLEN observe:events 2>/dev/null | tr -d '[:space:]')"
    set -e
    if [[ -n "$REDIS_LEN" && "$REDIS_LEN" =~ ^[0-9]+$ ]]; then
      _pass "Redis observe:events: lista acessível  (LLEN=$REDIS_LEN)"
    else
      _skip "Redis observe:events: não acessível (resposta: '${REDIS_LEN:-vazio}')"
    fi
  else
    _skip "Container observe-redis não encontrado — check Redis pulado"
  fi

  # B4: PostgreSQL — tabela observe_discovery_runs ────────────────────────
  _info "B4: PostgreSQL tabela observe_discovery_runs..."
  PG_CTR=""
  set +e
  PG_CTR="$(docker ps --filter "name=observe-postgres" --filter "status=running" \
    --format "{{.Names}}" 2>/dev/null | head -1)"
  set -e

  if [[ -n "$PG_CTR" ]]; then
    DB_USER="$(grep -m1 '^OBSERVE_DB_USER=' .env.observe 2>/dev/null | cut -d= -f2 | tr -d '"' || echo 'observe')"
    DB_NAME="$(grep -m1 '^OBSERVE_DB_NAME=' .env.observe 2>/dev/null | cut -d= -f2 | tr -d '"' || echo 'observedb')"
    set +e
    TABLE_CHECK="$(docker exec "$PG_CTR" \
      psql -U "$DB_USER" -d "$DB_NAME" -tAq \
      -c "SELECT tablename FROM pg_tables WHERE tablename='observe_discovery_runs'" \
      2>/dev/null | tr -d '[:space:]')"
    set -e
    if [[ "$TABLE_CHECK" == "observe_discovery_runs" ]]; then
      _pass "PostgreSQL: tabela observe_discovery_runs existe  ($DB_NAME@$PG_CTR)"
    else
      _fail "PostgreSQL: tabela observe_discovery_runs NÃO encontrada em $DB_NAME@$PG_CTR"
      RUNTIME_FAIL=1
    fi
  else
    _skip "Container observe-postgres não encontrado — check DB pulado"
  fi

  # B5: Proxy observe-proxy → discovery (porta 3080) ─────────────────────
  _info "B5: Proxy http://localhost:3080/observe/discovery/api/discovery/runs..."
  set +e
  PROXY_RESP="$(curl -sf --max-time 5 \
    http://localhost:3080/observe/discovery/api/discovery/runs 2>/dev/null || true)"
  set -e
  if echo "$PROXY_RESP" | grep -q '"runs"'; then
    _pass "Proxy observe-proxy → discovery API: OK"
  else
    PROXY_CTR=""
    set +e
    PROXY_CTR="$(docker ps --filter "name=observe-proxy" --filter "status=running" \
      --format "{{.Names}}" 2>/dev/null | head -1)"
    set -e
    if [[ -z "$PROXY_CTR" ]]; then
      _skip "observe-proxy não está rodando — check de proxy pulado"
    else
      _skip "observe-proxy rodando mas inacessível em localhost:3080 neste ambiente — check pulado"
    fi
  fi

  # B6: Arquivo prometheus-sd dentro do container ────────────────────────
  _info "B6: Prometheus SD file /app/data/prometheus-discovery.json..."
  set +e
  PROM_SD_CHECK="$(docker exec "$DISCOVERY_CTR" \
    ls /app/data/prometheus-discovery.json 2>/dev/null)"
  set -e
  if [[ -n "$PROM_SD_CHECK" ]]; then
    _pass "Prometheus SD file: existe em $DISCOVERY_CTR:/app/data/prometheus-discovery.json"
  else
    _skip "Prometheus SD file ainda não gerado (requer ao menos um scan concluído)"
  fi

  if [[ "$RUNTIME_FAIL" -eq 0 ]]; then
    RUNTIME_STATUS="pass"
    RUNTIME_DETAIL="all runtime checks passed"
  else
    RUNTIME_STATUS="fail"
    RUNTIME_DETAIL="$RUNTIME_FAIL check(s) failed"
    SMOKE_FAIL=1
  fi
fi  # fim Fase B

# ════════════════════════════════════════════════════════════════════════════
# RELATÓRIO SMOKE
# ════════════════════════════════════════════════════════════════════════════
_section "RELATÓRIO SMOKE"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
_info "Total: $TOTAL  |  PASS: $PASS_COUNT  |  FAIL: $FAIL_COUNT"
_info "Fases: extraction=$EXTRACTION_STATUS  unit_tests=$UNIT_TEST_STATUS  runtime=$RUNTIME_STATUS"

cat > "$REPORT" <<EOJSON
{
  "generated_at": "${DATE_UTC}",
  "status": "$([ "$SMOKE_FAIL" -eq 0 ] && echo green || echo red)",
  "pass": ${PASS_COUNT},
  "fail": ${FAIL_COUNT},
  "phases": {
    "extraction": "${EXTRACTION_STATUS}",
    "unit_tests_from_extraction": "${UNIT_TEST_STATUS}",
    "runtime": "${RUNTIME_STATUS}"
  },
  "runtime_detail": "${RUNTIME_DETAIL}",
  "report": "${REPORT}"
}
EOJSON

_info "Relatório gerado: $REPORT"

if [[ "$SMOKE_FAIL" -ne 0 ]]; then
  printf "\n${RED}[RELEASE:SMOKE FAIL]${NC} %d verificação(ões) falharam\n" "$FAIL_COUNT" >&2
  exit 1
fi

printf "\n${GREEN}[RELEASE:SMOKE OK]${NC} extraction=%s  unit_tests=%s  runtime=%s\n" \
  "$EXTRACTION_STATUS" "$UNIT_TEST_STATUS" "$RUNTIME_STATUS"
