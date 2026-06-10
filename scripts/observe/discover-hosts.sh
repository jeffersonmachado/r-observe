#!/usr/bin/env bash
# ─── discover-hosts.sh ────────────────────────────────────────────────────────
# Varre a rede local (ARP/nmap/ping) e registra os hosts descobertos no Icinga2.
#
# Modos de saída:
#   --mode api  (padrão) — registra via Icinga2 REST API usando docker exec
#   --mode file          — gera observe/icinga2/conf.d/hosts.conf
#
# Dependências no host: nmap  (ou arp-scan/arping como alternativa mais rápida)
#                       python3, docker, curl
#
# Uso:
#   ./discover-hosts.sh [--subnet 10.10.2.0/24] [--mode api|file]
#   ./discover-hosts.sh --dry-run          # mostra o que seria feito
#   ./discover-hosts.sh --list             # lista hosts já registrados
#   ./discover-hosts.sh --remove 10.10.2.5 # remove host da API
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Localização do repositório ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.observe"

# ── Defaults (sobrescritos por args ou .env.observe) ──────────────────────────
SUBNET="${DISCOVER_SUBNET:-}"
MODE="${DISCOVER_MODE:-api}"
R_OBSERVE_URL="${R_OBSERVE_URL:-http://localhost:3080}"
R_OBSERVE_TOKEN=""
_TOKEN_FROM_ARG=false
ICINGA_CONTAINER="${ICINGA_CONTAINER:-r-observe-icinga2}"
ICINGA_API_USER="${ICINGA_API_USER:-icingaweb2}"
ICINGA_API_PASSWORD="${ICINGA_API_PASSWORD:-}"
OUTPUT_FILE="${REPO_ROOT}/observe/icinga2/conf.d/hosts.conf"
DRY_RUN=false
LIST_ONLY=false
REMOVE_HOST=""
# Hosts conhecidos que sempre serão varridos independente de ping
# Formato: "ip:display_name ip:display_name ..."
KNOWN_HOSTS="${DISCOVER_KNOWN_HOSTS:-10.10.2.79:srvmysql0 10.10.2.89:srvmysql1 10.10.2.49:srvmysql2}"

# Portas de serviço verificadas no port scan
SCAN_PORTS="22,25,80,143,443,465,587,993,995,8080,11334"

# Portas de exportadores Prometheus (verificadas separadamente; /metrics validado)
EXPORTER_PORTS="9100,9104,9108,9115,9117,9121,9187,9256,9419,9090,9091"
# Mapeamento porta → job Prometheus
#  9100 node_exporter        9104 mysqld_exporter    9108 generic /metrics
#  9115 blackbox_exporter    9117 apache_exporter    9121 redis_exporter
#  9187 postgres_exporter    9256 process_exporter   9419 rabbitmq_exporter
#  9090 prometheus           9091 pushgateway

# Diretório de saída para File SD do Prometheus
SD_OUTPUT_DIR="${REPO_ROOT}/observe/prometheus/sd"
SD_OUTPUT_FILE="${SD_OUTPUT_DIR}/discovered.json"

# ── Cores ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[discover]${RESET} $*"; }
ok()   { echo -e "${GREEN}[ok]${RESET}      $*"; }
warn() { echo -e "${YELLOW}[warn]${RESET}    $*"; }
err()  { echo -e "${RED}[erro]${RESET}    $*" >&2; }
die()  { err "$*"; exit 1; }

# ── Parser de argumentos ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --subnet)   SUBNET="$2";        shift 2 ;;
    --mode)     MODE="$2";          shift 2 ;;
    --token)    R_OBSERVE_TOKEN="$2"; _TOKEN_FROM_ARG=true; shift 2 ;;
    --url)      R_OBSERVE_URL="$2";     shift 2 ;;
    --sd-dir)   SD_OUTPUT_DIR="$2"; SD_OUTPUT_FILE="${SD_OUTPUT_DIR}/discovered.json"; shift 2 ;;
    --container) ICINGA_CONTAINER="$2"; shift 2 ;;
    --output)   OUTPUT_FILE="$2";   shift 2 ;;
    --known-hosts) KNOWN_HOSTS="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true;       shift   ;;
    --list)     LIST_ONLY=true;     shift   ;;
    --remove)   REMOVE_HOST="$2";   shift 2 ;;
    --help|-h)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# *//'
      exit 0 ;;
    *) die "Argumento desconhecido: $1" ;;
  esac
done

# ── Carrega .env.observe se existir ───────────────────────────────────────────
if [[ -f "${ENV_FILE}" ]]; then
  # Importa apenas as variáveis relevantes (sem executar comandos)
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key="${key//[[:space:]]/}"
    val="${val#\"}" val="${val%\"}" val="${val#\'}" val="${val%\'}"
    case "$key" in
      ICINGA_API_USER)       [[ -z "${ICINGA_API_USER:-}"       ]] && ICINGA_API_USER="$val"       ;;
      ICINGA_API_PASSWORD)   [[ -z "${ICINGA_API_PASSWORD:-}"   ]] && ICINGA_API_PASSWORD="$val"   ;;
      ICINGA_CONTAINER)      [[ -z "${ICINGA_CONTAINER:-}"      ]] && ICINGA_CONTAINER="$val"      ;;
      JWT_SECRET)[[ -z "${R_OBSERVE_TOKEN:-}" ]] && [[ "${_TOKEN_FROM_ARG}" == "false" ]] && R_OBSERVE_TOKEN="$val" ;;
      R_OBSERVE_PUBLIC_URL)  [[ -z "${R_OBSERVE_URL:-http://localhost:3080}" ]] && R_OBSERVE_URL="$val" ;;
    esac
  done < "${ENV_FILE}"
fi

# Converte raw secret em JWT (quando lido do env, não de --token)
if [[ "${_TOKEN_FROM_ARG}" == "false" ]] && [[ -n "${R_OBSERVE_TOKEN}" ]]; then
  R_OBSERVE_TOKEN="$(JWT_SECRET="${R_OBSERVE_TOKEN}" node "${SCRIPT_DIR}/jwt-sign.js" discover-hosts 30m)"
fi

if [[ "${MODE}" != "r-observe" ]]; then
  [[ -z "${ICINGA_API_PASSWORD}" ]] && die "ICINGA_API_PASSWORD não definido. Defina em .env.observe ou exporte a variável."
fi

# ── Funções de descoberta ──────────────────────────────────────────────────────

# Detecta qual ferramenta de descoberta está disponível
detect_tool() {
  if command -v nmap &>/dev/null; then echo "nmap"
  elif command -v arp-scan &>/dev/null; then echo "arp-scan"
  elif command -v arping &>/dev/null; then echo "arping"
  else echo "ping"
  fi
}

# Auto-detecta subnets locais (exclui loopback e docker)
auto_detect_subnets() {
  ip -4 route show scope link 2>/dev/null \
    | awk '{print $1}' \
    | grep -vE '^(127\.|172\.(1[6-9]|2[0-9]|3[01])\.)'
}

# Descobre hosts vivos numa subnet
discover_hosts_in_subnet() {
  local subnet="$1"
  local tool
  tool=$(detect_tool)

  log "Varrendo ${subnet} com ${tool}..."

  case "$tool" in
    nmap)
      # -sn = ping scan (sem port scan), -T4 = timing agressivo
      nmap -sn -T4 --min-parallelism 50 "${subnet}" -oG - 2>/dev/null \
        | awk '/^Host:/ && /Status: Up/ {print $2}'
      ;;
    arp-scan)
      # arp-scan requer root na maioria dos sistemas
      arp-scan --localnet --quiet 2>/dev/null \
        | awk '/^[0-9]/ {print $1}'
      ;;
    arping)
      # arping verifica um host por vez — usa o fallback ping para varredura
      _ping_sweep "${subnet}"
      ;;
    ping)
      _ping_sweep "${subnet}"
      ;;
  esac
}

# Varredura ping paralela (fallback sem nmap/arp-scan)
_ping_sweep() {
  local subnet="$1"
  # Extrai o prefixo de rede (funciona para /24)
  local prefix
  prefix=$(echo "${subnet}" | grep -oP '^\d+\.\d+\.\d+')
  if [[ -z "${prefix}" ]]; then
    warn "Formato de subnet '${subnet}' não suportado pelo modo ping. Use /24."
    return
  fi
  local -a pids=()
  for i in $(seq 1 254); do
    ping -c1 -W1 "${prefix}.${i}" &>/dev/null && echo "${prefix}.${i}" &
    pids+=("$!")
  done
  wait "${pids[@]}" 2>/dev/null || true
}

# Faz port scan num host e retorna as portas abertas (uma por linha)
scan_ports() {
  local host="$1"
  if command -v nmap &>/dev/null; then
    nmap -p "${SCAN_PORTS}" --open -T4 -oG - "${host}" 2>/dev/null \
      | grep -oP '\d+(?=/open)' || true
  else
    # Fallback: bash TCP check porta a porta
    for port in ${SCAN_PORTS//,/ }; do
      timeout 1 bash -c ">/dev/tcp/${host}/${port}" 2>/dev/null && echo "${port}" || true
    done
  fi
}

# Tenta obter hostname via DNS reverso
reverse_dns() {
  local ip="$1"
  host "${ip}" 2>/dev/null | grep -oP 'pointer \K[\w.-]+' | sed 's/\.$//' || \
  python3 -c "import socket; print(socket.gethostbyaddr('${ip}')[0])" 2>/dev/null || \
  echo ""
}

# Normaliza IP em hostname seguro (ex: 10.10.2.30 ��� host-10-10-2-30)
ip_to_hostname() {
  echo "host-${1//./-}"
}

# ── Funções da API Icinga2 ──────────────────────────────────────────────────────

# Executa chamada à API Icinga2 via docker exec
icinga_api() {
  local method="$1"; local path="$2"; local body="${3:-}"
  local args=(-sk -X "${method}" -H "Accept: application/json"
               -u "${ICINGA_API_USER}:${ICINGA_API_PASSWORD}"
               "https://127.0.0.1:5665${path}")
  [[ -n "${body}" ]] && args+=(-H "Content-Type: application/json" --data "${body}")
  docker exec "${ICINGA_CONTAINER}" curl "${args[@]}"
}

# Verifica se um host já existe na API
host_exists() {
  local name="$1"
  local code
  code=$(docker exec "${ICINGA_CONTAINER}" curl -sk -o /dev/null -w "%{http_code}" \
    -u "${ICINGA_API_USER}:${ICINGA_API_PASSWORD}" \
    "https://127.0.0.1:5665/v1/objects/hosts/${name}" 2>/dev/null)
  [[ "${code}" == "200" ]]
}

# Constrói o payload JSON para criar/atualizar um host
build_payload() {
  local ip="$1" display_name="$2"
  shift 2
  # Argumentos restantes: porta=valor ...
  python3 - "${ip}" "${display_name}" "$@" <<'PYEOF'
import json, sys

ip          = sys.argv[1]
dname       = sys.argv[2]
port_args   = sys.argv[3:]

vars_dict = {
    "discovered": True,
    "os":         "Linux",
}
http_vhosts = {}

PORT_MAP = {
    "22":    None,                        # SSH via vars.os=Linux (base services.conf)
    "25":    ("smtp_port",           25),
    "80":    ("_http",               80),
    "143":   ("imap_port",           143),
    "443":   ("_https",              443),
    "465":   ("smtp_tls_port",       465),
    "587":   ("smtp_submission_port",587),
    "993":   ("imaps_port",          993),
    "995":   ("pop3s_port",          995),
    "8080":  ("_http_8080",          8080),
    "11334": ("check_rspamd",        True),
}

for port_str in port_args:
    port = port_str.strip()
    if port not in PORT_MAP or PORT_MAP[port] is None:
        continue
    key, val = PORT_MAP[port]
    if key.startswith("_http"):
        port_num = val
        ssl      = (port == "443")
        vhost_key = f"https-{port_num}" if ssl else f"http-{port_num}"
        entry = {"http_port": port_num}
        if ssl:
            entry["http_ssl"] = True
        http_vhosts[vhost_key] = entry
    else:
        vars_dict[key] = val

if http_vhosts:
    vars_dict["http_vhosts"] = http_vhosts

payload = {
    "templates": ["generic-host"],
    "attrs": {
        "address":      ip,
        "display_name": dname,
        "check_command":"hostalive",
        "vars":         vars_dict,
    }
}
print(json.dumps(payload))
PYEOF
}

# Registra host via Icinga2 API
register_host_api() {
  local ip="$1" name="$2" display_name="$3"
  shift 3
  local ports=("$@")

  local payload
  payload=$(build_payload "${ip}" "${display_name}" "${ports[@]:-}" 2>/dev/null) || {
    warn "Falha ao gerar payload para ${ip}"; return 1
  }

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo -e "${YELLOW}[dry-run]${RESET} PUT /v1/objects/hosts/${name}"
    echo "${payload}" | python3 -m json.tool 2>/dev/null || echo "${payload}"
    return
  fi

  local resp
  if host_exists "${name}"; then
    # Atualiza apenas os attrs (POST)
    local attrs
    attrs=$(echo "${payload}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'attrs':d['attrs']}))")
    resp=$(icinga_api POST "/v1/objects/hosts/${name}" "${attrs}" 2>/dev/null)
    ok "Atualizado: ${name} (${ip})"
  else
    resp=$(icinga_api PUT "/v1/objects/hosts/${name}" "${payload}" 2>/dev/null)
    ok "Registrado: ${name} (${ip}) — serviços: ${ports[*]:-nenhum}"
  fi

  # Verifica erros na resposta
  echo "${resp}" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for r in d.get('results',[]):
        if r.get('code',200) not in (200,):
            print('  aviso API:', r.get('status','?'), file=sys.stderr)
except: pass
" 2>&1 | grep -v '^$' | while read -r line; do warn "${line}"; done || true
}

# Lista hosts registrados na API
list_hosts() {
  log "Hosts registrados no Icinga2:"
  icinga_api GET "/v1/objects/hosts?attrs=address&attrs=display_name&attrs=vars" 2>/dev/null \
    | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    for r in sorted(d.get('results',[]), key=lambda x: x.get('attrs',{}).get('address','')):
        a = r.get('attrs',{})
        v = a.get('vars',{})
        svcs = [k for k in v if k in ('smtp_port','imap_port','imaps_port','smtp_submission_port',
                                       'smtp_tls_port','pop3s_port','check_rspamd','http_vhosts')]
        print(f\"  {a.get('address','?'):18s} {a.get('display_name','?'):30s} {svcs}\")
except Exception as e:
    print('Erro:', e, file=sys.stderr)
"
}

# Remove host da API
remove_host() {
  local host_name="$1"
  log "Removendo host '${host_name}'..."
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo -e "${YELLOW}[dry-run]${RESET} DELETE /v1/objects/hosts/${host_name}?cascade=1"
    return
  fi
  local resp
  resp=$(icinga_api DELETE "/v1/objects/hosts/${host_name}?cascade=1" 2>/dev/null)
  echo "${resp}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('results',[]):
    print('  status:', r.get('status','?'))
" 2>/dev/null
  ok "Removido: ${host_name}"
}

# ── Modo r-observe: POST para a API do R-Observe ──────────────────────────────

register_host_r_observe() {
  local ip="$1" name="$2" display_name="$3"
  shift 3
  local ports=("$@")

  # Constrói o JSON de vars a partir das portas abertas
  local vars_json
  vars_json=$(python3 - "${ports[@]:-}" <<'PYEOF'
import json, sys
PORT_MAP = {
    "25": "smtp_port", "143": "imap_port", "465": "smtp_tls_port",
    "587": "smtp_submission_port", "993": "imaps_port", "995": "pop3s_port",
    "11334": "check_rspamd",
}
vars = {}
for p in sys.argv[1:]:
    if p in PORT_MAP:
        vars[PORT_MAP[p]] = int(p) if p != "11334" else True
print(json.dumps(vars))
PYEOF
)

  local body
  body=$(python3 -c "
import json, sys
print(json.dumps({
  'name': sys.argv[1], 'address': sys.argv[2],
  'display_name': sys.argv[3], 'vars': json.loads(sys.argv[4])
}))" "${name}" "${ip}" "${display_name}" "${vars_json}")

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo -e "${YELLOW}[dry-run]${RESET} POST ${R_OBSERVE_URL}/observe/api/hosts"
    echo "${body}" | python3 -m json.tool 2>/dev/null || echo "${body}"
    return
  fi

  local http_code
  http_code=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "x-internal-token: ${R_OBSERVE_TOKEN}" \
    -d "${body}" \
    "${R_OBSERVE_URL}/observe/api/hosts" 2>/dev/null)

  case "${http_code}" in
    201) ok "Registrado via R-Observe: ${name} (${ip})" ;;
    200) ok "Atualizado via R-Observe: ${name} (${ip})" ;;
    401) warn "Token inválido para R-Observe (401). Use --token ou defina JWT_SECRET." ;;
    *)   warn "R-Observe respondeu HTTP ${http_code} para ${name}" ;;
  esac
}

# ── Scan de exporters Prometheus e geração de File SD ────────────────────────

# Mapeamento porta → job Prometheus para geração do SD
EXPORTER_JOB_MAP=(
  "9100:node-exporter"
  "9104:mysqld-exporter"
  "9108:generic-metrics"
  "9115:blackbox-exporter"
  "9117:apache-exporter"
  "9121:redis-exporter"
  "9187:postgres-exporter"
  "9256:process-exporter"
  "9419:rabbitmq-exporter"
  "9090:prometheus"
  "9091:pushgateway"
)

# Verifica se um endpoint realmente serve métricas Prometheus
is_metrics_endpoint() {
  local ip="$1" port="$2"
  local resp
  resp=$(curl -sf --max-time 3 "http://${ip}:${port}/metrics" 2>/dev/null | head -3)
  echo "${resp}" | grep -qE "^#\s*(HELP|TYPE)" && return 0
  return 1
}

# Faz scan das portas de exporters num host e retorna as abertas com job
scan_exporters() {
  local ip="$1"
  local -a found=()

  for mapping in "${EXPORTER_JOB_MAP[@]}"; do
    local port="${mapping%%:*}"
    local job="${mapping##*:}"

    # Verifica se a porta está aberta (TCP) — rápido
    if timeout 1 bash -c ">/dev/tcp/${ip}/${port}" 2>/dev/null; then
      # Valida que realmente serve /metrics
      if is_metrics_endpoint "${ip}" "${port}"; then
        found+=("${port}:${job}")
        log "  [exporter] ${ip}:${port} → ${job}"
      fi
    fi
  done

  echo "${found[@]:-}"
}

# Gera o arquivo JSON de File SD para o Prometheus
generate_prometheus_sd() {
  local -n _hosts_data_ref=$1  # mapa ip → "name:display_name:porta1:..."
  local -n _exporters_ref=$2   # mapa ip → "porta:job porta:job ..."

  mkdir -p "${SD_OUTPUT_DIR}"

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  python3 - "${SD_OUTPUT_FILE}" "${ts}" <<PYEOF
import json, sys, os

output_file = sys.argv[1]
timestamp   = sys.argv[2]

# Lê dados de hosts e exporters das variáveis de ambiente (passadas pelo bash)
import os
hosts_raw     = os.environ.get('SD_HOSTS_DATA', '')
exporters_raw = os.environ.get('SD_EXPORTERS_DATA', '')

groups = []

# Processa exporters por host
exporter_map = {}
for line in exporters_raw.splitlines():
    line = line.strip()
    if not line: continue
    parts = line.split('|', 1)
    if len(parts) == 2:
        ip, targets = parts[0], parts[1]
        for tgt in targets.split():
            port, job = tgt.split(':', 1)
            exporter_map.setdefault(ip, []).append((port, job))

for ip, entries in exporter_map.items():
    host_label = ip.replace('.', '-')
    for port, job in entries:
        groups.append({
            "targets": [f"{ip}:{port}"],
            "labels": {
                "job":        job,
                "host":       host_label,
                "host_ip":    ip,
                "discovered": "true",
                "source":     "r-observe-scan",
            }
        })

# Adiciona comentário de geração
result = {"_generated": timestamp, "_count": len(groups), "groups": groups}

with open(output_file, 'w') as f:
    json.dump(groups, f, indent=2)

print(f"[sd] {len(groups)} target(s) → {output_file}")
PYEOF
}

# ── Geração de arquivo hosts.conf ──────────────────────────────────────────────

gen_host_conf_entry() {
  local ip="$1" name="$2" display_name="$3"
  shift 3
  local ports=("$@")

  python3 - "${ip}" "${name}" "${display_name}" "${ports[@]:-}" <<'PYEOF'
import sys
ip, name, dname = sys.argv[1], sys.argv[2], sys.argv[3]
ports = sys.argv[4:]

PORT_MAP = {
    "25":    "  vars.smtp_port             = 25",
    "80":    '  vars.http_vhosts["http-80"] = { http_port = 80 }',
    "143":   "  vars.imap_port             = 143",
    "443":   '  vars.http_vhosts["https-443"] = { http_port = 443; http_ssl = true }',
    "465":   "  vars.smtp_tls_port         = 465",
    "587":   "  vars.smtp_submission_port  = 587",
    "993":   "  vars.imaps_port            = 993",
    "995":   "  vars.pop3s_port            = 995",
    "8080":  '  vars.http_vhosts["http-8080"] = { http_port = 8080 }',
    "11334": "  vars.check_rspamd          = true",
}

lines = [
    f'object Host "{name}" {{',
    f'  import       "generic-host"',
    f'  address      = "{ip}"',
    f'  display_name = "{dname}"',
    f'  check_command = "hostalive"',
    f'  vars.os        = "Linux"',
    f'  vars.discovered = true',
]
for p in ports:
    if p in PORT_MAP:
        lines.append(PORT_MAP[p])
lines.append("}")
print("\n".join(lines))
PYEOF
}

generate_hosts_file() {
  local -n _hosts_map=$1

  log "Gerando ${OUTPUT_FILE}..."
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  {
    echo "/**"
    echo " * Hosts descobertos automaticamente por discover-hosts.sh"
    echo " * Gerado em: ${ts}"
    echo " * ATENÇÃO: este arquivo é sobrescrito em cada varredura."
    echo " * Para hosts permanentes, use um arquivo separado."
    echo " */"
    echo ""

    for ip in "${!_hosts_map[@]}"; do
      IFS=':' read -ra parts <<< "${_hosts_map[$ip]}"
      local name="${parts[0]}"
      local display_name="${parts[1]}"
      local ports=("${parts[@]:2}")
      gen_host_conf_entry "${ip}" "${name}" "${display_name}" "${ports[@]:-}"
      echo ""
    done
  } > "${OUTPUT_FILE}"

  ok "Arquivo gerado: ${OUTPUT_FILE}"
  warn "Reinicie o Icinga2 para aplicar: docker compose -f docker-compose.observe.yml restart icinga2"
}

# ── Entrada principal ──────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}── R-Observe: discover-hosts ──────────────────────────────────${RESET}"

  # Operações de gerenciamento (sem varredura)
  if [[ "${LIST_ONLY}" == "true" ]]; then
    list_hosts; exit 0
  fi
  if [[ -n "${REMOVE_HOST}" ]]; then
    remove_host "${REMOVE_HOST}"; exit 0
  fi

  # Detecta ferramenta disponível
  local tool
  tool=$(detect_tool)
  log "Ferramenta de descoberta: ${tool}"

  if [[ "${tool}" == "ping" ]]; then
    warn "nmap não encontrado. Usando ping sweep (lento). Instale nmap para melhor resultado."
    warn "  Ubuntu/Debian: sudo apt install nmap"
    warn "  RHEL/AlmaLinux: sudo dnf install nmap"
  fi

  # Detecta subnets se não especificado
  if [[ -z "${SUBNET}" ]]; then
    log "Detectando subnets locais..."
    mapfile -t SUBNETS < <(auto_detect_subnets)
    if [[ ${#SUBNETS[@]} -eq 0 ]]; then
      die "Nenhuma subnet detectada. Use --subnet 192.168.1.0/24"
    fi
    log "Subnets encontradas: ${SUBNETS[*]}"
  else
    # Suporta múltiplas subnets separadas por vírgula
    IFS=',' read -ra SUBNETS <<< "${SUBNET}"
  fi

  # Coleta todos os IPs vivos
  declare -A LIVE_HOSTS=()
  for subnet in "${SUBNETS[@]}"; do
    subnet="${subnet// /}"  # remove espaços
    [[ -z "${subnet}" ]] && continue
    while IFS= read -r ip; do
      [[ -n "${ip}" ]] && LIVE_HOSTS["${ip}"]=1
    done < <(discover_hosts_in_subnet "${subnet}")
  done

  # Injeta hosts conhecidos (sempre incluídos, mesmo sem resposta ao ping)
  if [[ -n "${KNOWN_HOSTS}" ]]; then
    log "Injetando hosts conhecidos..."
    for entry in ${KNOWN_HOSTS}; do
      local kip="${entry%%:*}"
      [[ -n "${kip}" ]] && LIVE_HOSTS["${kip}"]=1
    done
  fi

  local total=${#LIVE_HOSTS[@]}
  log "Hosts vivos encontrados: ${total}"

  if [[ "${total}" -eq 0 ]]; then
    warn "Nenhum host encontrado. Verifique a subnet ou permissões de rede."
    exit 0
  fi

  # Associativo: ip → "name:display_name:porta1:porta2:..."
  declare -A HOSTS_DATA=()

  # Port scan e construção das vars por host
  # Para o modo prometheus-sd, também scaneamos portas de exporters
  declare -A EXPORTERS_DATA=()   # ip → "porta:job porta:job ..."

  for ip in "${!LIVE_HOSTS[@]}"; do
    log "Analisando ${ip}..."

    # Nome: preferência para hint de KNOWN_HOSTS, depois DNS reverso, depois derivado do IP
    local known_hint=""
    for entry in ${KNOWN_HOSTS}; do
      if [[ "${entry%%:*}" == "${ip}" ]]; then
        known_hint="${entry#*:}"
        break
      fi
    done

    local rdns
    rdns=$(reverse_dns "${ip}")
    local display_name="${known_hint:-${rdns:-${ip}}}"
    local name
    if [[ -n "${known_hint}" ]]; then
      # Normaliza hint para hostname válido: lowercase, espaços → hífens
      name=$(echo "${known_hint}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-.')
    elif [[ -n "${rdns}" ]]; then
      name="${rdns%%.*}"
      [[ "${name}" =~ ^(localhost|mail|www|smtp)$ ]] && name=$(ip_to_hostname "${ip}")
    else
      name=$(ip_to_hostname "${ip}")
    fi

    # Port scan de serviços (Icinga)
    mapfile -t open_ports < <(scan_ports "${ip}")
    local ports_str
    ports_str=$(IFS=':'; echo "${open_ports[*]:-}")
    HOSTS_DATA["${ip}"]="${name}:${display_name}:${ports_str}"

    local svc_list="${open_ports[*]:-nenhuma}"
    log "  ${ip} (${display_name}) — serviços: ${svc_list}"

    # Scan de exporters Prometheus (apenas nos modos que precisam)
    if [[ "${MODE}" == "prometheus-sd" ]] || [[ "${MODE}" == "all" ]]; then
      local exp_targets
      exp_targets=$(scan_exporters "${ip}")
      if [[ -n "${exp_targets}" ]]; then
        EXPORTERS_DATA["${ip}"]="${exp_targets}"
      fi
    fi
  done

  echo ""
  log "Modo: ${MODE} | Hosts: ${#HOSTS_DATA[@]}"

  # Aplica no modo escolhido
  case "${MODE}" in
    api)
      log "Registrando hosts via Icinga2 REST API (docker exec ${ICINGA_CONTAINER})..."
      echo ""
      for ip in "${!HOSTS_DATA[@]}"; do
        IFS=':' read -ra parts <<< "${HOSTS_DATA[$ip]}"
        local name="${parts[0]}"
        local display_name="${parts[1]}"
        local ports=("${parts[@]:2}")
        register_host_api "${ip}" "${name}" "${display_name}" "${ports[@]:-}"
      done
      echo ""
      if [[ "${DRY_RUN}" == "false" ]]; then
        log "Concluído. Use --list para ver todos os hosts registrados."
      fi
      ;;
    r-observe)
      [[ -z "${R_OBSERVE_TOKEN}" ]] && die "Token não encontrado. Use --token ou defina JWT_SECRET em .env.observe."
      log "Registrando hosts via R-Observe API (${R_OBSERVE_URL})..."
      echo ""
      for ip in "${!HOSTS_DATA[@]}"; do
        IFS=':' read -ra parts <<< "${HOSTS_DATA[$ip]}"
        local name="${parts[0]}"
        local display_name="${parts[1]}"
        local ports=("${parts[@]:2}")
        register_host_r_observe "${ip}" "${name}" "${display_name}" "${ports[@]:-}"
      done
      echo ""
      if [[ "${DRY_RUN}" == "false" ]]; then
        log "Concluído. Hosts registrados em DB e Icinga2 via R-Observe."
      fi
      ;;
    file)
      generate_hosts_file HOSTS_DATA
      ;;
    prometheus-sd)
      log "Gerando File SD para Prometheus em ${SD_OUTPUT_FILE}..."
      echo ""
      # Prepara variáveis de ambiente para o script Python
      local exporters_env=""
      for ip in "${!EXPORTERS_DATA[@]}"; do
        exporters_env+="${ip}|${EXPORTERS_DATA[$ip]}"$'\n'
      done
      SD_EXPORTERS_DATA="${exporters_env}" SD_HOSTS_DATA="" \
        generate_prometheus_sd HOSTS_DATA EXPORTERS_DATA
      echo ""
      ok "File SD gerado: ${SD_OUTPUT_FILE}"
      log "Targets encontrados: $(python3 -c "import json; d=json.load(open('${SD_OUTPUT_FILE}')); print(len(d))" 2>/dev/null || echo '?')"
      log "Recarregue o Prometheus: curl -X POST http://localhost:9090/-/reload"
      ;;
    all)
      # Registra hosts no Icinga (modo api) E gera File SD para Prometheus
      [[ -z "${ICINGA_API_PASSWORD}" ]] && die "ICINGA_API_PASSWORD não definido."
      log "Modo 'all': registrando no Icinga2 E gerando SD Prometheus..."
      echo ""
      for ip in "${!HOSTS_DATA[@]}"; do
        IFS=':' read -ra parts <<< "${HOSTS_DATA[$ip]}"
        local name="${parts[0]}"; local display_name="${parts[1]}"
        local ports=("${parts[@]:2}")
        register_host_api "${ip}" "${name}" "${display_name}" "${ports[@]:-}"
      done
      local exporters_env=""
      for ip in "${!EXPORTERS_DATA[@]}"; do
        exporters_env+="${ip}|${EXPORTERS_DATA[$ip]}"$'\n'
      done
      SD_EXPORTERS_DATA="${exporters_env}" SD_HOSTS_DATA="" \
        generate_prometheus_sd HOSTS_DATA EXPORTERS_DATA
      ok "Concluído: hosts no Icinga2 + SD em ${SD_OUTPUT_FILE}"
      ;;
    *)
      die "Modo inválido: '${MODE}'. Use: api, r-observe, file, prometheus-sd, all"
      ;;
  esac
}

main "$@"
