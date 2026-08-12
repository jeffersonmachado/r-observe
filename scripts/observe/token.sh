#!/usr/bin/env bash
# Gerencia tokens internos RS256 via @results/auth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRIVATE_KEY="${JWT_PRIVATE_KEY_FILE:-$ROOT_DIR/secrets/jwt_automation_private.pem}"
PUBLIC_KEY="${JWT_PUBLIC_KEY_FILE:-$ROOT_DIR/secrets/jwt_automation_public.pem}"
BASE_URL="${BASE_URL:-http://localhost:3080}"

die() { echo "ERRO: $*" >&2; exit 1; }
require_private() { [[ -f "$PRIVATE_KEY" ]] || die "chave privada ausente: $PRIVATE_KEY"; }
require_public() { [[ -f "$PUBLIC_KEY" ]] || die "chave pública ausente: $PUBLIC_KEY"; }

sign_token() {
  require_private
  JWT_PRIVATE_KEY_FILE="$PRIVATE_KEY" \
  JWT_ROLE="${JWT_ROLE:-operator}" \
  JWT_SCOPE="${JWT_SCOPE:-}" \
  JWT_TENANT_ID="${JWT_TENANT_ID:-default}" \
    node "$SCRIPT_DIR/jwt-sign.js" "${1:-internal-script}" "${2:-15m}"
}

copy_to_clipboard() {
  local token="$1"
  if command -v wl-copy >/dev/null 2>&1; then printf '%s' "$token" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then printf '%s' "$token" | xclip -selection clipboard
  elif command -v xsel >/dev/null 2>&1; then printf '%s' "$token" | xsel --clipboard --input
  else return 1
  fi
}

cmd_show() {
  require_public
  echo "Algoritmo: RS256"
  echo "Chave pública: $PUBLIC_KEY"
  echo "Fingerprint SHA-256:"
  openssl pkey -pubin -in "$PUBLIC_KEY" -outform DER 2>/dev/null | openssl dgst -sha256
  echo "Token efêmero (15m):"
  sign_token token-show 15m
}

cmd_copy() {
  local token
  token="$(sign_token token-copy 15m)"
  echo "$token"
  copy_to_clipboard "$token" && echo "(copiado)" || echo "(clipboard indisponível)"
}

cmd_verify() {
  local token code
  token="$(sign_token token-verify 5m)"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H "x-internal-token: $token" \
    "$BASE_URL/observe/api/ai/settings" || true)"
  [[ "$code" == "200" ]] || die "token rejeitado ou serviço indisponível (HTTP $code)"
  echo "Token RS256 válido (HTTP 200)"
}

cmd_rotate() {
  require_private
  require_public
  echo "A rotação da automação exige reiniciar somente os serviços verificadores."
  read -r -p "Gerar e substituir o par atual? [s/N] " confirm
  [[ "${confirm,,}" == "s" ]] || die "cancelado"
  JWT_KEY_DIR="$(dirname "$PRIVATE_KEY")" "$SCRIPT_DIR/jwt-keys.sh" rotate automation
}

usage() {
  echo "Uso: $(basename "$0") <show|copy|verify|rotate>"
  echo "Variáveis: JWT_PRIVATE_KEY_FILE, JWT_PUBLIC_KEY_FILE, JWT_ROLE, JWT_SCOPE, JWT_TENANT_ID, BASE_URL"
}

case "${1:-}" in
  show) cmd_show ;;
  copy) cmd_copy ;;
  verify) cmd_verify ;;
  rotate) cmd_rotate ;;
  *) usage; exit 1 ;;
esac
