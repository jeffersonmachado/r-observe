#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[discovery:audit] Auditoria estrutural e de segurança"

FAIL=0
ok() { echo "[PASS] $1"; }
ko() { echo "[FAIL] $1" >&2; FAIL=1; }

# 1) Não existe caminho absoluto /opt/results/infra.
if grep -RIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist "/opt/results/infra" r-observe/discovery scripts/discovery | grep -v "scripts/discovery/discovery-audit.sh" >/dev/null; then
  ko "caminho absoluto /opt/results/infra encontrado"
else
  ok "sem caminho absoluto /opt/results/infra"
fi

# 2) docker.sock não está RW.
if grep -RIn --include='docker-compose*.yml' "/var/run/docker.sock:/var/run/docker.sock:rw\|/var/run/docker.sock:rw" . >/dev/null; then
  ko "docker.sock montado RW"
else
  ok "docker.sock sem montagem RW explícita"
fi

# 3) Docker discovery pode ser desabilitado por ENV.
if grep -n "DISCOVERY_DOCKER_ENABLED" r-observe/discovery/src/index.js >/dev/null; then
  ok "Docker discovery controlado por ENV"
else
  ko "faltando controle de Docker discovery por ENV"
fi

# 4) Profile padrão safe.
if grep -RIn --include='*.js' "profile: task.profile || 'safe'\|scan_profile || 'safe'\|profile === 'safe'" r-observe/discovery/src >/dev/null; then
  ok "profile padrão safe identificado"
else
  ko "profile padrão safe não identificado"
fi

# 5/6) allowlist + blacklist
if grep -n "allowed_ranges" r-observe/discovery/src/security/guardrails.js >/dev/null; then ok "allowlist presente"; else ko "allowlist ausente"; fi
if grep -n "blocked_ranges\|DEFAULT_BLOCKED_PREFIXES" r-observe/discovery/src/security/guardrails.js >/dev/null; then ok "blacklist presente"; else ko "blacklist ausente"; fi

# 7) timeout por host
if grep -n "host_timeout_ms" r-observe/discovery/src/security/guardrails.js >/dev/null; then ok "timeout por host presente"; else ko "timeout por host ausente"; fi

# 8) limite de concorrência
if grep -n "max_concurrency" r-observe/discovery/src/security/guardrails.js r-observe/discovery/src/engine/discovery-engine.js >/dev/null; then ok "limite de concorrência presente"; else ko "limite de concorrência ausente"; fi

# 9) throttling
if grep -n "max_rate_per_minute\|throttlePerTargetMs" r-observe/discovery/src/security/guardrails.js r-observe/discovery/src/engine/discovery-engine.js >/dev/null; then ok "scan throttling presente"; else ko "scan throttling ausente"; fi

# 10) scans agressivos não por padrão
if grep -n "validProfiles = \['safe', 'balanced', 'aggressive'\]" r-observe/discovery/src/index.js >/dev/null && \
   grep -n "'safe'" r-observe/discovery/src/index.js >/dev/null; then
  ok "scans agressivos não são padrão"
else
  ko "política de scan default não segura"
fi

# 11) logs não vazam secrets (checagem de termos sensíveis em mensagens de log)
if grep -RIn --include='*.js' "log(\|console\.log\|console\.error" r-observe/discovery/src | grep -E "JWT_SECRET|DB_PASSWORD|REDIS_URL|ICINGA_API_PASSWORD" >/dev/null; then
  ko "possível vazamento de secret em log"
else
  ok "sem vazamento óbvio de secrets em logs"
fi

# 12) sem mascaramento com || true nos scripts/gates discovery
if grep -RInF --include='*.sh' --include='*.js' "|| true" scripts/discovery r-observe/discovery/src | grep -v "scripts/discovery/discovery-audit.sh" >/dev/null; then
  ko "uso de '|| true' detectado"
else
  ok "sem '|| true'"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[discovery:audit] FAIL" >&2
  exit 1
fi

echo "[discovery:audit] OK"
