#!/bin/bash
# Wrapper para alterar senha no R-Observe (local ou produção)
# Uso:
#   ./scripts/passwd.sh admin novaSenha           # local
#   ./scripts/passwd.sh admin novaSenha --prod    # produção (10.10.2.30)

set -e

USERNAME="$1"
PASSWORD="$2"
TARGET="${3:-local}"

if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  echo "Uso: ./scripts/passwd.sh <username> <nova-senha> [--prod]"
  echo ""
  echo "  local : altera no ambiente dev local (docker exec r-observe-api)"
  echo "  --prod: altera no ambiente de produção (ssh root@10.10.2.30)"
  exit 1
fi

if [ "$TARGET" = "--prod" ]; then
  # SSH_PASSWORD: tenta variável de ambiente, senão pede interativamente
  if [ -z "$SSH_PASSWORD" ]; then
    echo -n "Senha SSH para root@10.10.2.30: "
    read -s SSH_PASSWORD
    echo ""
  fi
  if [ -z "$SSH_PASSWORD" ]; then
    echo "Erro: SSH_PASSWORD não definida. Exporte ou defina no ambiente."
    echo "  export SSH_PASSWORD='sua-senha'"
    exit 1
  fi
  echo "🔐 Produção (10.10.2.30): alterando senha de '$USERNAME'..."
  # Usa printf para evitar problemas com caracteres especiais na senha
  printf -v safe_cmd "docker exec -e OBSERVE_CLI_TARGET=prod r-observe-api node /app/scripts/cli-passwd.js %q %q" "$USERNAME" "$PASSWORD"
  sshpass -p "$SSH_PASSWORD" ssh -o StrictHostKeyChecking=no root@10.10.2.30 "$safe_cmd"
else
  echo "🔐 Local: alterando senha de '$USERNAME'..."
  # Garante que o CLI está no container
  docker cp /opt/results/r-observe/scripts/cli-passwd.js r-observe-api:/app/scripts/cli-passwd.js 2>/dev/null || true
  docker exec r-observe-api node /app/scripts/cli-passwd.js "$USERNAME" "$PASSWORD"
fi
