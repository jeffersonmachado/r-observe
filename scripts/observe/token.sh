#!/usr/bin/env bash
# Gerencia o JWT_SECRET do stack R-Observe.
set -euo pipefail

# ─── Caminhos ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${INFRA_DIR}/.env.observe"
CONTAINER="r-observe-api"

# ─── Helpers ─────────────────────────────────────────────────────────────────
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n'   "$*"; }

die() { red "ERRO: $*" >&2; exit 1; }

token_from_file() {
  [[ -f "$ENV_FILE" ]] || die ".env.observe não encontrado em $ENV_FILE"
  grep -E '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2
}

token_from_container() {
  local inspect_err
  inspect_err="$(docker inspect "$CONTAINER" 2>&1 >/dev/null || true)"
  if [[ -n "$inspect_err" ]]; then
    if grep -qiE 'permission denied|operation not permitted' <<<"$inspect_err"; then
      die "Sem permissão para consultar o Docker daemon. Rode com usuário no grupo docker ou use sudo."
    fi
    die "Container '$CONTAINER' não está em execução."
  fi
  docker exec "$CONTAINER" printenv JWT_SECRET 2>/dev/null || die "Variável JWT_SECRET não encontrada no container."
}

copy_to_clipboard() {
  local token="$1"
  if command -v xclip &>/dev/null; then
    printf '%s' "$token" | xclip -selection clipboard && echo "(copiado com xclip)"
  elif command -v xsel &>/dev/null; then
    printf '%s' "$token" | xsel --clipboard --input && echo "(copiado com xsel)"
  elif command -v wl-copy &>/dev/null; then
    printf '%s' "$token" | wl-copy && echo "(copiado com wl-copy)"
  else
    yellow "Clipboard não disponível — copie manualmente."
  fi
}

validate_token() {
  local token="$1"
  local file_token
  file_token="$(token_from_file)"
  [[ "$token" == "$file_token" ]] && green "✓ Token do container bate com .env.observe" \
                                  || yellow "⚠ Token do container DIFERE do .env.observe"
}

# ─── Comandos ─────────────────────────────────────────────────────────────────

cmd_show() {
  bold "─── Token em .env.observe"
  token_from_file

  echo ""
  bold "─── Token no container ($CONTAINER)"
  local inspect_err
  inspect_err="$(docker inspect "$CONTAINER" 2>&1 >/dev/null || true)"
  if [[ -z "$inspect_err" ]]; then
    local ctoken
    ctoken="$(token_from_container)"
    echo "$ctoken"
    validate_token "$ctoken"
  elif grep -qiE 'permission denied|operation not permitted' <<<"$inspect_err"; then
    yellow "Sem permissão para consultar o Docker daemon neste usuário."
  else
    yellow "Container não está em execução."
  fi
}

cmd_copy() {
  local src="${1:-file}"
  local token
  if [[ "$src" == "container" ]]; then
    bold "Lendo token do container '$CONTAINER'…"
    token="$(token_from_container)"
  else
    bold "Lendo token do arquivo .env.observe…"
    token="$(token_from_file)"
  fi
  echo "$token"
  copy_to_clipboard "$token"
}

cmd_verify() {
  local token
  token="$(token_from_file)"
  [[ -z "$token" ]] && die "Token não encontrado em .env.observe"

  local base_url="${BASE_URL:-http://localhost:3080}"
  bold "Verificando token contra $base_url/observe/api/ai/settings …"

  local http_code
  http_code=$(curl -sf -o /dev/null -w "%{http_code}" \
    -H "x-internal-token: $token" \
    "${base_url}/observe/api/ai/settings") || true

  case "$http_code" in
    200) green "✓ Token válido (HTTP 200)" ;;
    401) red   "✗ Token rejeitado (HTTP 401)" ;;
    000) yellow "⚠ Serviço inacessível (sem resposta)" ;;
    *)   yellow "⚠ HTTP $http_code inesperado" ;;
  esac
}

cmd_rotate() {
  [[ -f "$ENV_FILE" ]] || die ".env.observe não encontrado."

  local new_token
  new_token="$(openssl rand -hex 32)"

  bold "Novo token gerado:"
  echo "$new_token"

  # Confirma antes de sobrescrever
  echo ""
  read -r -p "Atualizar .env.observe e reiniciar containers? [s/N] " confirm
  [[ "${confirm,,}" == "s" ]] || { yellow "Cancelado."; exit 0; }

  # Substitui no .env.observe
  if grep -q '^JWT_SECRET=' "$ENV_FILE"; then
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${new_token}|" "$ENV_FILE"
  else
    echo "JWT_SECRET=${new_token}" >> "$ENV_FILE"
  fi
  green "✓ .env.observe atualizado"

  # Reinicia os containers afetados
  bold "Reiniciando containers…"
  docker compose -f "${INFRA_DIR}/docker-compose.observe.yml" \
    --env-file "$ENV_FILE" \
    --profile observe-core \
    --profile observe-ai \
    --profile observe-proxy \
    up -d --no-build \
    r-observe-api r-observe-worker r-observe-ai observe-proxy 2>&1 | grep -E 'Starting|Started|Recreat|Running|error' || true

  green "✓ Rotate concluído. Novo token:"
  echo "$new_token"
  copy_to_clipboard "$new_token"
}

cmd_recover() {
  bold "─── Tentando recuperar token…"

  # 1. Arquivo
  if [[ -f "$ENV_FILE" ]]; then
    local file_token
    file_token="$(token_from_file)"
    if [[ -n "$file_token" ]]; then
      green "✓ Recuperado de .env.observe:"
      echo "$file_token"
      copy_to_clipboard "$file_token"
      return
    fi
  fi

  # 2. Container
  if docker inspect "$CONTAINER" &>/dev/null; then
    local ctoken
    ctoken="$(token_from_container 2>/dev/null)"
    if [[ -n "$ctoken" ]]; then
      yellow "⚠ .env.observe não tem o token — recuperado do container (salve-o!):"
      echo "$ctoken"
      copy_to_clipboard "$ctoken"

      read -r -p "Salvar no .env.observe agora? [s/N] " save
      if [[ "${save,,}" == "s" ]]; then
        if grep -q '^JWT_SECRET=' "$ENV_FILE" 2>/dev/null; then
          sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${ctoken}|" "$ENV_FILE"
        else
          echo "JWT_SECRET=${ctoken}" >> "$ENV_FILE"
        fi
        green "✓ Token salvo em .env.observe"
      fi
      return
    fi
  fi

  red "✗ Não foi possível recuperar o token (arquivo ausente e container parado)."
  echo ""
  yellow "Gere um novo token com:  $0 rotate"
  exit 1
}

# ─── Uso ──────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Uso: $(basename "$0") <comando>

Comandos:
  show              Exibe token do arquivo e do container, compara os dois
  copy [file|container]
                    Copia o token para o clipboard (padrão: file)
  verify            Testa o token contra a API em execução
  rotate            Gera novo token, atualiza .env.observe e reinicia containers
  recover           Tenta recuperar o token (arquivo → container → erro)

Variáveis de ambiente:
  BASE_URL          URL base da API (padrão: http://localhost:3080)
  ENV_FILE          Caminho do .env.observe (padrão: <infra>/.env.observe)
EOF
}

# ─── Entrada ─────────────────────────────────────────────────────────────────
case "${1:-}" in
  show)    cmd_show ;;
  copy)    cmd_copy "${2:-file}" ;;
  verify)  cmd_verify ;;
  rotate)  cmd_rotate ;;
  recover) cmd_recover ;;
  *)       usage; exit 1 ;;
esac
