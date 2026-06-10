#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MAX_ATTEMPTS="${RELEASE_LOOP_MAX_ATTEMPTS:-0}"
ATTEMPT=1

while :; do
  echo "[release-enterprise-loop] tentativa ${ATTEMPT}"
  if bash ./scripts/package/release-ci-hardened.sh; then
    echo "[release-enterprise-loop] OK na tentativa ${ATTEMPT}"
    exit 0
  fi

  if [[ "$MAX_ATTEMPTS" != "0" && "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]]; then
    echo "[release-enterprise-loop] FAIL apos ${ATTEMPT} tentativas" >&2
    exit 1
  fi

  ATTEMPT=$((ATTEMPT + 1))
  echo "[release-enterprise-loop] repetindo pipeline devido a falha"
done
