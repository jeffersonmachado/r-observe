#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[discovery:lint] Iniciando lint estrutural do Discovery Engine"

FAIL=0

must_exist=(
  "r-observe/discovery/src/index.js"
  "r-observe/discovery/src/engine/discovery-engine.js"
  "r-observe/discovery/src/fingerprint/engine.js"
  "r-observe/discovery/src/topology/engine.js"
  "r-observe/discovery/src/security/guardrails.js"
)

for f in "${must_exist[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "[discovery:lint] FAIL arquivo ausente: $f" >&2
    FAIL=1
  fi
done

if grep -RIn --exclude-dir=node_modules --exclude-dir=.git -- "\t" r-observe/discovery/src >/dev/null; then
  echo "[discovery:lint] INFO tabs encontrados no código (permitido), mantendo estilo existente"
fi

if grep -RIn --exclude-dir=node_modules --exclude-dir=.git -- "console\.log(" r-observe/discovery/src >/dev/null; then
  echo "[discovery:lint] FAIL uso de console.log no src (use logger)" >&2
  FAIL=1
fi

if grep -RIn --exclude-dir=node_modules --exclude-dir=.git -- "TODO\|FIXME\|HACK" r-observe/discovery/src >/dev/null; then
  echo "[discovery:lint] FAIL marcador TODO/FIXME/HACK encontrado no src" >&2
  FAIL=1
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "[discovery:lint] FAIL" >&2
  exit 1
fi

echo "[discovery:lint] OK"
