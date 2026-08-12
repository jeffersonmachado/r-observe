#!/usr/bin/env bash
# Gerencia pares RSA independentes para identidades M2M.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
KEY_DIR="${JWT_KEY_DIR:-$ROOT_DIR/secrets}"
SERVICES=(api worker agent discovery automation)

die() { echo "ERRO: $*" >&2; exit 1; }

generate_pair() {
  local service="$1" private="$KEY_DIR/jwt_${service}_private.pem" public="$KEY_DIR/jwt_${service}_public.pem"
  if [[ -e "$private" || -e "$public" ]]; then
    [[ -s "$private" && -s "$public" ]] || die "par incompleto para $service em $KEY_DIR"
    echo "mantido: $service"
    return
  fi
  local temporary
  temporary="$(mktemp -d "$KEY_DIR/.jwt-${service}.XXXXXX")"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$temporary/private.pem" >/dev/null 2>&1
  openssl pkey -in "$temporary/private.pem" -pubout -out "$temporary/public.pem" >/dev/null 2>&1
  chmod 600 "$temporary/private.pem"
  chmod 644 "$temporary/public.pem"
  mv "$temporary/private.pem" "$private"
  mv "$temporary/public.pem" "$public"
  rmdir "$temporary"
  echo "gerado: $service"
}

init_keys() {
  command -v openssl >/dev/null 2>&1 || die "openssl não encontrado"
  umask 077
  mkdir -p "$KEY_DIR"
  chmod 700 "$KEY_DIR"
  local service
  for service in "${SERVICES[@]}"; do generate_pair "$service"; done
}

show_keys() {
  local service public
  for service in "${SERVICES[@]}"; do
    public="$KEY_DIR/jwt_${service}_public.pem"
    [[ -s "$public" ]] || die "chave pública ausente: $public"
    printf '%-12s ' "$service"
    openssl pkey -pubin -in "$public" -outform DER 2>/dev/null | openssl dgst -sha256
  done
}

rotate_key() {
  local service="${1:-}" known=false item
  for item in "${SERVICES[@]}"; do [[ "$item" == "$service" ]] && known=true; done
  [[ "$known" == "true" ]] || die "serviço inválido: ${service:-ausente}"
  local private="$KEY_DIR/jwt_${service}_private.pem" public="$KEY_DIR/jwt_${service}_public.pem"
  [[ -s "$private" && -s "$public" ]] || die "par atual ausente para $service"
  local stamp temporary
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  temporary="$(mktemp -d "$KEY_DIR/.jwt-${service}.XXXXXX")"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$temporary/private.pem" >/dev/null 2>&1
  openssl pkey -in "$temporary/private.pem" -pubout -out "$temporary/public.pem" >/dev/null 2>&1
  chmod 600 "$temporary/private.pem"
  chmod 644 "$temporary/public.pem"
  cp -p "$private" "$private.$stamp.bak"
  cp -p "$public" "$public.$stamp.bak"
  mv "$temporary/private.pem" "$private"
  mv "$temporary/public.pem" "$public"
  rmdir "$temporary"
  echo "rotacionado: $service"
  echo "reinicie o emissor e os verificadores que confiam em $service"
}

case "${1:-init}" in
  init) init_keys ;;
  show) show_keys ;;
  rotate) rotate_key "${2:-}" ;;
  *) die "uso: $(basename "$0") [init|show|rotate <api|worker|agent|discovery|automation>]" ;;
esac
