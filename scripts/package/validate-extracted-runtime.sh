#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ZIP_FILE="${1:-}"
if [[ -z "$ZIP_FILE" || ! -f "$ZIP_FILE" ]]; then
  echo "[validate-extracted-runtime] erro: informe um ZIP valido" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d /tmp/infra-extracted-runtime.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

EXTRACT_DIR="$TMP_DIR/extracted"
mkdir -p "$EXTRACT_DIR"

echo "[validate-extracted-runtime] unzip: $ZIP_FILE -> $EXTRACT_DIR"
unzip -q "$ZIP_FILE" -d "$EXTRACT_DIR"

run_step() {
  local label="$1"
  shift
  echo "[validate-extracted-runtime] RUN: $label"
  (
    cd "$EXTRACT_DIR"
    "$@"
  )
}

run_step "npm ci (root)" npm ci --prefer-offline --no-audit --no-fund
run_step "npm ci (discovery)" npm --prefix r-observe/discovery ci --prefer-offline --no-audit --no-fund
run_step "npm test (discovery)" npm --prefix r-observe/discovery test
run_step "discovery lint" bash scripts/discovery/discovery-lint.sh
run_step "discovery audit" bash scripts/discovery/discovery-audit.sh
echo "[validate-extracted-runtime] RUN: discovery enterprise smoke"
(
  cd "$EXTRACT_DIR"
  DISCOVERY_ENTERPRISE_SMOKE_MODE=isolated bash scripts/discovery/discovery-enterprise-smoke.sh
)
run_step "validate extracted package" node scripts/release/validate-extracted-package.js --root "$EXTRACT_DIR" --run-install --run-tests --run-smoke

echo "[validate-extracted-runtime] OK: $ZIP_FILE"
