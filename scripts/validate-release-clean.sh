#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OUT_DIR="$ROOT_DIR/dist"
mkdir -p "$OUT_DIR"
REPORT_FILE="$OUT_DIR/release-validation-report.json"

# Regras focadas em artefato de release gerado (não em assets legítimos do app)
BLOCK_REGEX='^(dist/|node_modules/|coverage/|test-results/|playwright-report/|screenshots/|dumps/|backups/|tmp/|\.env$|\.env\.remote-)'

mapfile -t tracked_bad < <(git ls-files | rg -n "$BLOCK_REGEX" || true)
mapfile -t workspace_bad < <(
  {
    find dist -maxdepth 2 -type f 2>/dev/null || true
    find . -maxdepth 1 -type f \( -name '*.zip' -o -name '*.tar' -o -name '*.log' \) | sed 's#^\./##'
  } | sort -u
)

status="green"
if [[ ${#tracked_bad[@]} -gt 0 ]]; then
  status="red"
fi

{
  echo "{"
  echo "  \"generated_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," 
  echo "  \"status\": \"$status\"," 
  echo "  \"tracked_blocked_count\": ${#tracked_bad[@]},"
  echo "  \"workspace_artifacts_count\": ${#workspace_bad[@]},"
  echo "  \"tracked_blocked\": ["
  for i in "${!tracked_bad[@]}"; do
    line="${tracked_bad[$i]//\"/\\\"}"
    sep=","
    [[ "$i" -eq $((${#tracked_bad[@]} - 1)) ]] && sep=""
    echo "    \"$line\"$sep"
  done
  echo "  ],"
  echo "  \"workspace_artifacts\": ["
  for i in "${!workspace_bad[@]}"; do
    line="${workspace_bad[$i]//\"/\\\"}"
    sep=","
    [[ "$i" -eq $((${#workspace_bad[@]} - 1)) ]] && sep=""
    echo "    \"$line\"$sep"
  done
  echo "  ]"
  echo "}"
} > "$REPORT_FILE"

if [[ "$status" != "green" ]]; then
  echo "[validate-release-clean] FAIL: artefatos proibidos versionados. Veja $REPORT_FILE" >&2
  exit 1
fi

echo "[validate-release-clean] OK: release limpo. Relatório: $REPORT_FILE"
