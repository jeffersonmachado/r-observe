#!/usr/bin/env bash
# ─── R-Observe Enterprise Installer ─────────────────────────────────────────
# Uso: sudo bash install.sh [OPCOES]
#
# Opções:
#   --host           Endereço de bind (default: 0.0.0.0)
#   --port           Porta HTTP (default: 3080)
#   --data-dir       Diretório de dados (default: /opt/results/r-observe/data)
#   --db-password    Senha do PostgreSQL (obrigatório se não definida em env)
#   --redis-password Senha do Redis
#   --admin-user     Usuário admin inicial (default: admin)
#   --admin-pass     Senha admin inicial (obrigatório)
#   --no-icinga      Não instalar Icinga2
#   --no-monitoring  Não instalar Prometheus/Grafana/Loki
#   --no-ai          Não instalar serviço de IA
#   --accept-eula    Aceitar EULA automaticamente
#   --help           Esta ajuda
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Cores ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*"; }
step()  { printf "\n${CYAN}═══════════════════════════════════════════════════════${NC}\n"; printf "${BLUE}[STEP]${NC} %s\n" "$*"; }

# ─── Defaults ─────────────────────────────────────────────────────────────────
INSTALL_HOST="0.0.0.0"
INSTALL_PORT="3080"
DATA_DIR="/opt/results/r-observe/data"
DB_PASSWORD=""
REDIS_PASSWORD=""
ADMIN_USER="admin"
ADMIN_PASS=""
WITH_ICINGA=true
WITH_MONITORING=true
WITH_AI=true
ACCEPT_EULA=false

# ─── Parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) INSTALL_HOST="$2"; shift 2 ;;
    --port) INSTALL_PORT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --db-password) DB_PASSWORD="$2"; shift 2 ;;
    --redis-password) REDIS_PASSWORD="$2"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-pass) ADMIN_PASS="$2"; shift 2 ;;
    --no-icinga) WITH_ICINGA=false; shift ;;
    --no-monitoring) WITH_MONITORING=false; shift ;;
    --no-ai) WITH_AI=false; shift ;;
    --accept-eula) ACCEPT_EULA=true; shift ;;
    --help)
      head -20 "$0" | grep -E '^# ' | sed 's/^# //' | sed 's/^#//'
      exit 0 ;;
    *) error "Argumento desconhecido: $1"; exit 1 ;;
  esac
done

# ─── Pre-flight checks ────────────────────────────────────────────────────────
step "Pre-flight checks"

if [[ "$(id -u)" -ne 0 ]]; then
  error "Este script deve ser executado como root (ou com sudo)"
  exit 1
fi

# Verifica Docker
if ! command -v docker &>/dev/null; then
  error "Docker não encontrado. Instale o Docker 20.10+ primeiro."
  echo "  curl -fsSL https://get.docker.com | sh"
  exit 1
fi

DOCKER_VERSION=$(docker --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1)
if [[ -z "$DOCKER_VERSION" ]] || [[ "$(printf '%s\n' "20.10" "$DOCKER_VERSION" | sort -V | head -1)" != "20.10" ]]; then
  warn "Docker $DOCKER_VERSION detectado. Recomendado: 20.10+"
fi

# Verifica Docker Compose
if ! docker compose version &>/dev/null; then
  error "Docker Compose plugin não encontrado."
  exit 1
fi

# Verifica recursos minimos
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
CPU_CORES=$(nproc)
DISK_GB=$(df -BG "$DATA_DIR" 2>/dev/null | awk 'NR==2{print $4}' | sed 's/G//' || echo "0")

info "Sistema: $(uname -s) $(uname -m)"
info "Memória: ${MEM_MB}MB | CPU: ${CPU_CORES} cores | Disco: ${DISK_GB}GB disponível"

if [[ "$MEM_MB" -lt 2048 ]]; then
  warn "Memória RAM < 2GB. Recomendado: 4GB+ para stack completa."
fi
if [[ "$CPU_CORES" -lt 2 ]]; then
  warn "CPU < 2 cores. Recomendado: 4+ cores."
fi
if [[ "${DISK_GB:-0}" -lt 10 ]]; then
  warn "Disco < 10GB disponível. Recomendado: 20GB+."
fi

# ─── EULA ──────────────────────────────────────────────────────────────────────
if [[ "$ACCEPT_EULA" != "true" ]]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  R-Observe Enterprise — Contrato de Licença (EULA)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Ao continuar, você concorda com os termos de licença do R-Observe."
  echo "  Para uso comercial, é necessária uma licença válida."
  echo ""
  read -rp "  Digite 'ACEITO' para continuar: " EULA_INPUT
  if [[ "$EULA_INPUT" != "ACEITO" ]]; then
    error "EULA não aceito. Instalação cancelada."
    exit 1
  fi
fi

# ─── Valida inputs ────────────────────────────────────────────────────────────
if [[ -z "$DB_PASSWORD" ]]; then
  if [[ -n "${OBSERVE_DB_PASSWORD:-}" ]]; then
    DB_PASSWORD="$OBSERVE_DB_PASSWORD"
  else
    DB_PASSWORD=$(openssl rand -base64 24 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
    info "Senha administrativa do banco gerada automaticamente"
  fi
fi

if [[ -z "$REDIS_PASSWORD" ]]; then
  if [[ -n "${OBSERVE_REDIS_PASSWORD:-}" ]]; then
    REDIS_PASSWORD="$OBSERVE_REDIS_PASSWORD"
  else
    REDIS_PASSWORD=$(openssl rand -base64 24 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
  fi
fi

DB_APP_PASSWORD=$(openssl rand -base64 24 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
DB_EXPORTER_PASSWORD=$(openssl rand -base64 24 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)

if [[ -z "$ADMIN_PASS" ]]; then
  if [[ -n "${OBSERVE_ADMIN_PASSWORD:-}" ]]; then
    ADMIN_PASS="$OBSERVE_ADMIN_PASSWORD"
  else
    error "--admin-pass é obrigatório."
    echo "  Use: sudo bash install.sh --admin-pass 'SuaSenhaSegura123!'"
    exit 1
  fi
fi

# ─── Gerar secrets ────────────────────────────────────────────────────────────
step "Gerando secrets"

JWT_KEY_DIR="$PROJECT_DIR/secrets" bash "$PROJECT_DIR/scripts/observe/jwt-keys.sh" init

RELEASE_KEY=$(openssl rand -base64 32 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)

info "Secrets gerados com sucesso"

# ─── Diretórios ───────────────────────────────────────────────────────────────
step "Criando diretórios de dados"

mkdir -p "$DATA_DIR"/{postgres,redis,grafana,prometheus,loki,evidence,replays,logs}
mkdir -p "$DATA_DIR"/icinga/{etc,var}
chmod 750 "$DATA_DIR"

info "Diretórios criados em: $DATA_DIR"

# ─── .env.observe ─────────────────────────────────────────────────────────────
step "Gerando .env.observe"

ENV_FILE="$PROJECT_DIR/.env.observe"

cat > "$ENV_FILE" << EOF
# ─── R-Observe Enterprise ────────────────────────────────────────────────
# Gerado por install.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Database ──────────────────────────────────────────────────────────────
OBSERVE_DB_NAME=observedb
OBSERVE_DB_USER=observe
OBSERVE_DB_PASSWORD=$DB_PASSWORD
OBSERVE_DB_APP_USER=observe_app
OBSERVE_DB_APP_PASSWORD=$DB_APP_PASSWORD
OBSERVE_DB_EXPORTER_USER=observe_exporter
OBSERVE_DB_EXPORTER_PASSWORD=$DB_EXPORTER_PASSWORD
OBSERVE_DB_PORT=5432
ICINGADB_DB_NAME=icingadb
ICINGADB_DB_USER=icingadb
ICINGADB_DB_PASSWORD=$(openssl rand -base64 24 2>/dev/null || tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)

# ── Redis ─────────────────────────────────────────────────────────────────
OBSERVE_REDIS_PASSWORD=$REDIS_PASSWORD
OBSERVE_REDIS_PORT=6379

# ── Admin ─────────────────────────────────────────────────────────────────
ICINGAWEB_ADMIN_USER=$ADMIN_USER
ICINGAWEB_ADMIN_PASS=$ADMIN_PASS

# ── JWT ───────────────────────────────────────────────────────────────────
JWT_ISSUER=r-observe
JWT_MAX_LIFETIME=30m
JWT_CLOCK_TOLERANCE_SECONDS=5

# ── AI ────────────────────────────────────────────────────────────────────
R_OBSERVE_AI_ENABLED=$WITH_AI
R_OBSERVE_AI_TIMEOUT_MS=30000

# ── Tentant ───────────────────────────────────────────────────────────────
R_OBSERVE_TENANT_MODE=single

# ── CORS ──────────────────────────────────────────────────────────────────
OBSERVE_CORS_ORIGINS=

# ── Logging ───────────────────────────────────────────────────────────────
OBSERVE_LOG_LEVEL=info
OBSERVE_LOG_MAX_SIZE=50m
OBSERVE_LOG_MAX_FILE=5

# ── Environment ───────────────────────────────────────────────────────────
NODE_ENV=production
TZ=America/Sao_Paulo

# ── Release ───────────────────────────────────────────────────────────────
RELEASE_KEY=$RELEASE_KEY
EOF

chmod 600 "$ENV_FILE"
info ".env.observe gerado em: $ENV_FILE"

# ─── Build e Deploy ───────────────────────────────────────────────────────────
step "Build das imagens Docker"

cd "$PROJECT_DIR"

COMPOSE_FILE="docker-compose.observe.yml"
PROFILES="--profile observe-core"

if [[ "$WITH_AI" == "true" ]]; then
  PROFILES="$PROFILES --profile observe-ai"
fi
if [[ "$WITH_MONITORING" == "true" ]]; then
  PROFILES="$PROFILES --profile observe-monitoring"
fi
if [[ "$WITH_ICINGA" == "true" ]]; then
  PROFILES="$PROFILES --profile observe-icinga"
fi

PROFILES="$PROFILES --profile r-observe-proxy"

info "Build profiles: $PROFILES"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Iniciando build e deploy..."
echo "  Isso pode levar alguns minutos na primeira execução."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" $PROFILES build 2>&1; then
  info "Build concluído com sucesso"
else
  error "Falha no build. Verifique os logs acima."
  exit 1
fi

info "Iniciando containers..."

if COMPOSE_PARALLEL_LIMIT=1 docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" $PROFILES up -d 2>&1; then
  info "Containers iniciados"
else
  error "Falha ao iniciar containers."
  exit 1
fi

# ─── Health Check ─────────────────────────────────────────────────────────────
step "Verificando saúde dos serviços"

echo "Aguardando serviços iniciarem..."
sleep 5

MAX_WAIT=120
WAITED=0
INTERVAL=5

check_health() {
  local url="$1"
  local label="$2"
  curl -sf -o /dev/null "$url" 2>/dev/null && return 0 || return 1
}

SERVICES_OK=0
SERVICES_TOTAL=0

# API
SERVICES_TOTAL=$((SERVICES_TOTAL + 1))
while [[ $WAITED -lt $MAX_WAIT ]]; do
  if check_health "http://127.0.0.1:${INSTALL_PORT}/observe/api/health" "API"; then
    info "API: OK"
    SERVICES_OK=$((SERVICES_OK + 1))
    break
  fi
  sleep "$INTERVAL"
  WAITED=$((WAITED + INTERVAL))
done
if [[ $WAITED -ge $MAX_WAIT ]]; then
  warn "API não respondeu em ${MAX_WAIT}s"
fi

# Resumo
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  R-Observe Enterprise — Instalação Concluída"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  URL:         http://${INSTALL_HOST}:${INSTALL_PORT}"
echo "  Usuário:     $ADMIN_USER"
echo "  Senha:       $ADMIN_PASS"
echo ""
echo "  Serviços:    $SERVICES_OK/$SERVICES_TOTAL OK"
echo "  Data dir:    $DATA_DIR"
echo "  Env file:    $ENV_FILE"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Comandos úteis:"
echo "    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps"
echo "    docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f"
echo "    bash $PROJECT_DIR/installer/upgrade.sh"
echo "    bash $PROJECT_DIR/installer/backup.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
