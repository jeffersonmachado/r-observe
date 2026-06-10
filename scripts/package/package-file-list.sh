#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

REQUIRED_FILE="${1:-scripts/package/required-enterprise-files.txt}"
RELEASEIGNORE_FILE="${RELEASEIGNORE_FILE:-.releaseignore}"

releaseignore_match() {
  local path="$1"
  local pattern="$2"

  pattern="${pattern#./}"
  [[ -z "$pattern" ]] && return 1

  if [[ "$pattern" == */ ]]; then
    local dir="${pattern%/}"
    [[ "$path" == "$dir" || "$path" == "$dir/"* ]]
    return $?
  fi

  case "$path" in
    $pattern) return 0 ;;
  esac

  if [[ "$pattern" != */* ]]; then
    case "$path" in
      */$pattern) return 0 ;;
    esac
  fi

  return 1
}

is_releaseignored_path() {
  local path="$1"
  local ignored=1
  local line neg pattern

  [[ -f "$RELEASEIGNORE_FILE" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    neg=0
    pattern="$line"
    if [[ "$pattern" == !* ]]; then
      neg=1
      pattern="${pattern#!}"
    fi

    if releaseignore_match "$path" "$pattern"; then
      if [[ "$neg" -eq 1 ]]; then
        ignored=1
      else
        ignored=0
      fi
    fi
  done < "$RELEASEIGNORE_FILE"

  return "$ignored"
}

is_git_repo() {
  git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

is_excluded_path() {
  local path="$1"

  case "$path" in
    .git/*|*/.git/*|.gitignore|.gitattributes|.gitmodules|*/.gitignore|*/.gitattributes|*/.gitmodules|node_modules/*|*/node_modules/*|dist/*|*/dist/*|coverage/*|*/coverage/*|test-results/*|*/test-results/*|playwright-report/*|*/playwright-report/*|screenshots/*|*/screenshots/*|traces/*|*/traces/*|tmp/*|*/tmp/*|temp/*|*/temp/*|cache/*|*/cache/*|.cache/*|*/.cache/*|dumps/*|*/dumps/*|backups/*|*/backups/*)
      return 0
      ;;
    *.dump|*.dmp|*.sql.gz|*.bak|*.tmp|*.swp|*.log)
      return 0
      ;;
  esac

  if [[ "$path" =~ (^|/)\.env($|\.) ]]; then
    return 0
  fi

  if [[ "$path" =~ (^|/)\.token\.env$ ]] || [[ "$path" =~ (^|/)[^/]+\.token\.env$ ]]; then
    return 0
  fi

  if [[ "$path" =~ \.(pem|key|p12|pfx|kdbx)$ ]]; then
    return 0
  fi

  if is_releaseignored_path "$path"; then
    return 0
  fi

  return 1
}

collect_workspace_files() {
  local -a raw=()

  if is_git_repo; then
    mapfile -d '' -t raw < <(git -C "$ROOT_DIR" ls-files -z --cached --others --exclude-standard --)
  else
    mapfile -d '' -t raw < <(find . -type f -print0)
  fi

  local p
  for p in "${raw[@]}"; do
    p="${p#./}"
    [[ -z "$p" ]] && continue
    if is_excluded_path "$p"; then
      continue
    fi
    printf '%s\n' "$p"
  done
}

TMP_RAW="$(mktemp)"
trap 'rm -f "$TMP_RAW"' EXIT

collect_workspace_files > "$TMP_RAW"

if [[ ! -f "$REQUIRED_FILE" ]]; then
  echo "[package-file-list] erro: arquivo de obrigatorios ausente: $REQUIRED_FILE" >&2
  exit 1
fi

while IFS= read -r req; do
  [[ -z "$req" ]] && continue
  [[ "$req" =~ ^# ]] && continue
  if [[ ! -f "$req" ]]; then
    echo "[package-file-list] erro: arquivo obrigatorio ausente no workspace: $req" >&2
    exit 1
  fi
  if is_excluded_path "$req"; then
    echo "[package-file-list] erro: arquivo obrigatorio bloqueado por releaseignore/filtro: $req" >&2
    exit 1
  fi
  printf '%s\n' "$req" >> "$TMP_RAW"
done < "$REQUIRED_FILE"

LC_ALL=C sort -u "$TMP_RAW"
