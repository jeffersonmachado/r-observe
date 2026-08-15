#!/usr/bin/env bash
# Gera limites de recursos (CPU/memória) adaptativos para a stack r-observe,
# de acordo com as características do servidor (CPUs e RAM total).
#
# Os valores são expostos como variáveis OBSERVE_LIMIT_* e consumidos pelo
# docker-compose.observe.yml (que já referencia ${OBSERVE_LIMIT_...:-padrão}).
#
# Referência: servidor de 4 CPUs / 16 GiB (limites atuais do compose).
# Servidores maiores ganham limites maiores; menores ganham limites menores,
# com pisos (floors) para não descer demais.
#
# Uso:
#   scripts/observe/compute-resource-limits.sh                 # imprime exports
#   scripts/observe/compute-resource-limits.sh --write <arquivo.env>   # atualiza .env
#   OBSERVE_TOTAL_CPUS=8 OBSERVE_TOTAL_MEMORY_MB=32768 scripts/observe/compute-resource-limits.sh
set -euo pipefail

detect_cpus() {
  if [ -n "${OBSERVE_TOTAL_CPUS:-}" ]; then
    printf '%s\n' "${OBSERVE_TOTAL_CPUS}"
    return
  fi
  command -v nproc >/dev/null 2>&1 && nproc || grep -c '^processor' /proc/cpuinfo
}

detect_memory_mb() {
  if [ -n "${OBSERVE_TOTAL_MEMORY_MB:-}" ]; then
    printf '%s\n' "${OBSERVE_TOTAL_MEMORY_MB}"
    return
  fi
  # MemTotal em kB → MB
  awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo
}

clamp() {
  # clamp <valor> <min> <max>
  awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN { if (v < lo) v = lo; if (v > hi) v = hi; printf "%.3f", v }'
}

round_cpu() {
  # Arredonda para o 0.05 mais próximo (0.10, 0.25, 0.50, 0.75, 1.00...),
  # evitando drift de ponto flutuante no caso de referência (scale=1).
  awk -v v="$1" 'BEGIN { printf "%g", int(v * 20 + 0.5) / 20 }'
}

round_mem() {
  # Arredonda para múltiplo de 64 MiB (valores limpos: 64M, 128M, 256M, 512M...).
  awk -v v="$1" 'BEGIN { m = int(v / 64 + 0.5) * 64; printf "%dM", m }'
}

main() {
  local cpus mem_mb scale_cpu scale_mem
  cpus="$(detect_cpus)"
  mem_mb="$(detect_memory_mb)"

  scale_cpu="$(clamp "$(awk -v c="$cpus" 'BEGIN { printf "%.3f", c / 4 }')" 0.5 3.0)"
  scale_mem="$(clamp "$(awk -v m="$mem_mb" 'BEGIN { printf "%.3f", m / 16384 }')" 0.5 3.0)"

  # CPU: base * scale, com pisos por tier.
  local cpu_small cpu_low cpu_med cpu_high cpu_max
  cpu_small="$(round_cpu "$(clamp "$(awk -v s="$scale_cpu" 'BEGIN { printf "%.3f", 0.1 * s }')" 0.1 3.0)")"
  cpu_low="$(round_cpu "$(clamp "$(awk -v s="$scale_cpu" 'BEGIN { printf "%.3f", 0.25 * s }')" 0.1 3.0)")"
  cpu_med="$(round_cpu "$(clamp "$(awk -v s="$scale_cpu" 'BEGIN { printf "%.3f", 0.5 * s }')" 0.25 3.0)")"
  cpu_high="$(round_cpu "$(clamp "$(awk -v s="$scale_cpu" 'BEGIN { printf "%.3f", 0.75 * s }')" 0.5 3.0)")"
  cpu_max="$(round_cpu "$(clamp "$(awk -v s="$scale_cpu" 'BEGIN { printf "%.3f", 1.0 * s }')" 0.5 3.0)")"

  # Memória: base * scale, com pisos por tier.
  local mem_xs mem_sm mem_md mem_lg mem_xl
  mem_xs="$(round_mem "$(clamp "$(awk -v s="$scale_mem" 'BEGIN { printf "%.3f", 64 * s }')" 32 8192)")"
  mem_sm="$(round_mem "$(clamp "$(awk -v s="$scale_mem" 'BEGIN { printf "%.3f", 128 * s }')" 64 8192)")"
  mem_md="$(round_mem "$(clamp "$(awk -v s="$scale_mem" 'BEGIN { printf "%.3f", 256 * s }')" 128 8192)")"
  mem_lg="$(round_mem "$(clamp "$(awk -v s="$scale_mem" 'BEGIN { printf "%.3f", 512 * s }')" 256 8192)")"
  # XL: worker com Chromium do canal WhatsApp QR. O init do WA Web estoura
  # 512M e, desde o rollout WA Web 2.3000.1041xxx (jun/2026) + Chrome 146,
  # o boot+injeção estoura também 1G (OOM kill no memcg confirmado em prod
  # via dmesg, ago/2026) — por isso a referência subiu para 2G.
  mem_xl="$(round_mem "$(clamp "$(awk -v s="$scale_mem" 'BEGIN { printf "%.3f", 2048 * s }')" 1024 8192)")"

  local lines
  lines="$(cat <<EOF
OBSERVE_LIMIT_CPU_SMALL=${cpu_small}
OBSERVE_LIMIT_CPU_LOW=${cpu_low}
OBSERVE_LIMIT_CPU_MED=${cpu_med}
OBSERVE_LIMIT_CPU_HIGH=${cpu_high}
OBSERVE_LIMIT_CPU_MAX=${cpu_max}
OBSERVE_LIMIT_MEM_XS=${mem_xs}
OBSERVE_LIMIT_MEM_SM=${mem_sm}
OBSERVE_LIMIT_MEM_MD=${mem_md}
OBSERVE_LIMIT_MEM_LG=${mem_lg}
OBSERVE_LIMIT_MEM_XL=${mem_xl}
EOF
)"

  if [ "${1:-}" = "--write" ] && [ -n "${2:-}" ]; then
    local file="$2"
    # Remove bloco antigo de OBSERVE_LIMIT_* e anexa o novo (idempotente).
    if [ -f "$file" ]; then
      sed -i '/^OBSERVE_LIMIT_/d' "$file"
    fi
    {
      printf '\n# Limites de recursos gerados por compute-resource-limits.sh (CPUs=%s, RAM=%s MiB)\n' "$cpus" "$mem_mb"
      printf '%s\n' "$lines"
    } >> "$file"
    echo "Limites gravados em $file (CPUs=$cpus, RAM=${mem_mb}MiB, scale_cpu=$scale_cpu, scale_mem=$scale_mem)" >&2
  else
    printf '# CPUs=%s RAM=%sMiB scale_cpu=%s scale_mem=%s\n' "$cpus" "$mem_mb" "$scale_cpu" "$scale_mem" >&2
    printf '%s\n' "$lines"
  fi
}

main "$@"
