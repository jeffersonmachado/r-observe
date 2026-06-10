#!/usr/bin/env bash
set -euo pipefail

ZIP_FILE="${1:-}"
if [[ -z "$ZIP_FILE" || ! -f "$ZIP_FILE" ]]; then
  echo "[validate-zip] erro: informe um zip valido" >&2
  exit 1
fi

ZIP_BASE="$(basename "$ZIP_FILE" .zip)"
LOG_DIR="$(dirname "$ZIP_FILE")"
LOG_FILE="${LOG_DIR}/${ZIP_BASE}-validate.log"
REPORT_FILE="${LOG_DIR}/${ZIP_BASE}-enterprise-validate.json"
RUNTIME_FLAG="${VALIDATE_ZIP_RUNTIME:-1}"
VALIDATE_ARGS=(--zip "$ZIP_FILE" --report "$REPORT_FILE")

if [[ "$RUNTIME_FLAG" == "1" ]]; then
  VALIDATE_ARGS+=(--runtime)
fi

mkdir -p "$LOG_DIR"
: > "$LOG_FILE"

{
  echo "[validate-zip] start zip=${ZIP_FILE}"
  node ./scripts/release/validate-enterprise-package.js "${VALIDATE_ARGS[@]}"
  echo "[validate-zip] ok report=${REPORT_FILE}"
} | tee -a "$LOG_FILE"
