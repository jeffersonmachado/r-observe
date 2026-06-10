#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ "${RELEASE_LOCK_HELD:-0}" != "1" ]]; then
  RELEASE_LOCK_FILE="${RELEASE_LOCK_FILE:-/tmp/infra-release.lock}"
  exec 9>"$RELEASE_LOCK_FILE"
  if ! flock -n 9; then
    echo "[zip-release] erro: outro pipeline de release esta em execucao (lock: $RELEASE_LOCK_FILE)" >&2
    exit 1
  fi
  export RELEASE_LOCK_HELD=1
  export RELEASE_LOCK_FILE
fi

OUTPUT="dist/infra-release.zip"
DIST_CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --clean-dist)
      DIST_CLEAN=1
      shift
      ;;
    *)
      echo "[zip-release] erro: argumento desconhecido: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p dist

OUTPUT_BASE="$(basename "$OUTPUT" .zip)"
MANIFEST_TXT="dist/${OUTPUT_BASE}-manifest.txt"
MANIFEST_JSON="dist/${OUTPUT_BASE}-manifest.json"
HASH_FILE="${OUTPUT}.sha256"
RUN_LOG="dist/${OUTPUT_BASE}-zip.log"
STAGING_DIR=""
PROVENANCE_JSON="dist/${OUTPUT_BASE}-provenance.json"
ATTESTATION_JSON="dist/${OUTPUT_BASE}-attestation.json"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1704067200}"

MIN_FILE_COUNT=500
ZIP_LEVEL="${ZIP_COMPRESSION_LEVEL:-3}"
TIMING_LOG="dist/zip-timing.log"

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
timelog() {
  local line
  line="$(timestamp) | $1"
  printf '[zip-release] %s\n' "$1"
  printf '%s\n' "$line" >> "$TIMING_LOG"
  printf '%s\n' "$line" >> "$RUN_LOG"
}

run_with_heartbeat() {
  local label="$1"
  shift
  local t0 now elapsed hb rc

  t0="$(date +%s)"
  (
    while :; do
      sleep 15
      now="$(date +%s)"
      elapsed=$((now - t0))
      printf '[zip-release] %s... %ss\n' "$label" "$elapsed" >&2
    done
  ) &
  hb=$!

  set +e
  "$@"
  rc=$?
  set -e

  kill "$hb" >/dev/null 2>&1 || true
  wait "$hb" 2>/dev/null || true

  return "$rc"
}

touch "$TIMING_LOG"
: > "$RUN_LOG"

TMP_RAW="$(mktemp)"
TMP_SORTED="$(mktemp)"
trap 'rm -f "$TMP_RAW" "$TMP_SORTED"; rm -rf "$STAGING_DIR"' EXIT

timelog "zip_start output=${OUTPUT} level=${ZIP_LEVEL}"

if [[ "$DIST_CLEAN" -eq 1 ]]; then
  timelog "dist_clean mode=full"
  rm -rf dist
  mkdir -p dist
  touch "$TIMING_LOG"
  : > "$RUN_LOG"
fi

rm -f "$OUTPUT" "$MANIFEST_TXT" "$MANIFEST_JSON" "$HASH_FILE" "$PROVENANCE_JSON" "$ATTESTATION_JSON"
STAGING_DIR="$(mktemp -d "/tmp/infra-release-${OUTPUT_BASE}.XXXXXX")"

t0_collect=$(date +%s)
./scripts/package/package-file-list.sh > "$TMP_RAW"
t1_collect=$(date +%s)
timelog "collect_files duration_s=$((t1_collect - t0_collect))"

t0_sort=$(date +%s)
LC_ALL=C sort -u "$TMP_RAW" > "$TMP_SORTED"
t1_sort=$(date +%s)
timelog "sort_manifest duration_s=$((t1_sort - t0_sort))"

while IFS= read -r required_path; do
  [[ -z "$required_path" ]] && continue
  if [[ ! -f "$required_path" ]]; then
    echo "[zip-release] erro: arquivo listado nao existe no workspace: $required_path" >&2
    exit 1
  fi
done < "$TMP_SORTED"

t0_stage=$(date +%s)
run_with_heartbeat "montando staging (${OUTPUT_BASE})" tar -cf - -T "$TMP_SORTED" | tar -xf - -C "$STAGING_DIR"
find "$STAGING_DIR" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +
t1_stage=$(date +%s)
timelog "stage_payload duration_s=$((t1_stage - t0_stage))"

while IFS= read -r required_path; do
  [[ -z "$required_path" ]] && continue
  [[ "$required_path" =~ ^# ]] && continue
  if [[ ! -f "$STAGING_DIR/$required_path" ]]; then
    echo "[zip-release] erro: arquivo obrigatorio ausente no staging: $required_path" >&2
    exit 1
  fi
done < scripts/package/required-enterprise-files.txt

# Compacta somente o staging limpo. Manifestos externos sao gerados depois do ZIP real.
t0_zip=$(date +%s)
OUTPUT_ABS="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
(cd "$STAGING_DIR" && run_with_heartbeat "compactando payload (${OUTPUT_BASE})" zip -q -X "-${ZIP_LEVEL}" "$OUTPUT_ABS" -@ < "$TMP_SORTED")
t1_zip=$(date +%s)
timelog "zip_payload duration_s=$((t1_zip - t0_zip))"

zipinfo -1 "$OUTPUT" | sed 's#^\./##' | LC_ALL=C sort -u > "$MANIFEST_TXT"

COUNT=$(wc -l < "$MANIFEST_TXT" | tr -d ' ')
if [[ "$COUNT" -lt "$MIN_FILE_COUNT" ]]; then
  echo "[zip-release] erro: pacote com poucos arquivos ($COUNT < $MIN_FILE_COUNT)" >&2
  exit 1
fi

ZIP_SHA="$(sha256sum "$OUTPUT" | awk '{print $1}')"
MANIFEST_SHA="$(sha256sum "$MANIFEST_TXT" | awk '{print $1}')"
DATE_UTC=$(date -u -d "@${SOURCE_DATE_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)
cat > "$MANIFEST_JSON" <<EOF
{
  "generated_at": "$DATE_UTC",
  "output": "$OUTPUT",
  "file_count": $COUNT,
  "manifest_sha256": "$MANIFEST_SHA",
  "zip_sha256": "$ZIP_SHA",
  "manifest_txt_sha256": "$MANIFEST_SHA"
}
EOF

GIT_HEAD="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_STATUS_SHA="$(git status --short 2>/dev/null | sha256sum | awk '{print $1}')"
cat > "$PROVENANCE_JSON" <<EOF
{
  "schema": "infra.release.provenance.v1",
  "generated_at": "$DATE_UTC",
  "source_date_epoch": $SOURCE_DATE_EPOCH,
  "git_head": "$GIT_HEAD",
  "git_status_sha256": "$GIT_STATUS_SHA",
  "builder": "scripts/package/zip-release.sh",
  "artifact": "$OUTPUT",
  "file_count": $COUNT,
  "zip_sha256": "$ZIP_SHA",
  "manifest_txt_sha256": "$MANIFEST_SHA"
}
EOF

ATTESTATION_SHA="$(sha256sum "$PROVENANCE_JSON" "$MANIFEST_JSON" "$MANIFEST_TXT" | sha256sum | awk '{print $1}')"
cat > "$ATTESTATION_JSON" <<EOF
{
  "schema": "infra.release.attestation.v1",
  "generated_at": "$DATE_UTC",
  "artifact": "$OUTPUT",
  "artifact_sha256": "$ZIP_SHA",
  "provenance": "$(basename "$PROVENANCE_JSON")",
  "manifest": "$(basename "$MANIFEST_JSON")",
  "manifest_txt": "$(basename "$MANIFEST_TXT")",
  "attestation_sha256": "$ATTESTATION_SHA"
}
EOF

printf '%s  %s\n' "$ZIP_SHA" "$(basename "$OUTPUT")" > "$HASH_FILE"
timelog "zip_sha256 file=${HASH_FILE} value=${ZIP_SHA}"

# Validacao obrigatoria do conteudo
t0_validate=$(date +%s)
run_with_heartbeat "validando zip (${OUTPUT_BASE})" bash ./scripts/package/validate-zip.sh "$OUTPUT"
t1_validate=$(date +%s)
timelog "zip_validate duration_s=$((t1_validate - t0_validate))"

total=$((t1_validate - t0_collect))
timelog "zip_end output=${OUTPUT} file_count=${COUNT} total_s=${total}"
timelog "artifacts manifest_txt=${MANIFEST_TXT} manifest_json=${MANIFEST_JSON} hash_file=${HASH_FILE} provenance=${PROVENANCE_JSON} attestation=${ATTESTATION_JSON}"
timelog "validate_log script=./scripts/package/validate-zip.sh output=${OUTPUT}"

echo "[zip-release] OK: $OUTPUT"
echo "[zip-release] log: $RUN_LOG"
echo "[zip-release] timing: $TIMING_LOG"
