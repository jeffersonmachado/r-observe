'use strict';

/**
 * R-Observe AIOps — Knowledge Base
 *
 * Base de conhecimento para:
 *   1. Remediation playbooks (runbooks)
 *   2. Soluções conhecidas para problemas comuns
 *   3. Artigos técnicos indexados
 *   4. Feedback loop de aprendizado
 */

// ─── Remediation Playbooks ──────────────────────────────────────────────────

const PLAYBOOKS = [
  {
    id: 'pb_disk_full',
    title: 'Disco cheio — Procedimento de limpeza',
    triggers: [
      { check_type: 'disk', severity: ['critical', 'warning'] },
    ],
    steps: [
      { order: 1, action: 'Identificar partição cheia', command: 'df -h' },
      { order: 2, action: 'Encontrar diretórios grandes', command: 'du -sh /* 2>/dev/null | sort -rh | head -20' },
      { order: 3, action: 'Limpar logs do sistema', command: 'journalctl --vacuum-size=500M' },
      { order: 4, action: 'Limpar logs Docker', command: 'docker system prune -af --volumes' },
      { order: 5, action: 'Verificar logs de aplicação', command: 'find /var/log -type f -name "*.log" -mtime +30 -delete' },
      { order: 6, action: 'Se for banco de dados, verificar WAL/logs', command: 'Verificar pg_wal ou binlogs' },
    ],
    risk: 'low',
    auto_ok: false,
    estimated_time_minutes: 15,
  },
  {
    id: 'pb_high_cpu',
    title: 'CPU alta — Diagnóstico e mitigação',
    triggers: [
      { check_type: 'load', severity: ['critical'] },
    ],
    steps: [
      { order: 1, action: 'Identificar processo com maior consumo', command: 'ps aux --sort=-%cpu | head -10' },
      { order: 2, action: 'Verificar processos zumbis', command: 'ps aux | grep defunct' },
      { order: 3, action: 'Verificar I/O wait', command: 'iostat -x 1 3' },
      { order: 4, action: 'Se for container, verificar limites', command: 'docker stats --no-stream' },
      { order: 5, action: 'Reiniciar serviço problemático (se seguro)', command: 'systemctl restart <service>' },
    ],
    risk: 'medium',
    auto_ok: false,
    estimated_time_minutes: 20,
  },
  {
    id: 'pb_service_down',
    title: 'Serviço parado — Procedimento de recuperação',
    triggers: [
      { status: ['down', 'critical'], target_type: ['service', 'application'] },
    ],
    steps: [
      { order: 1, action: 'Verificar status do serviço', command: 'systemctl status <service>' },
      { order: 2, action: 'Verificar logs recentes', command: 'journalctl -u <service> --since "10 minutes ago" -n 50' },
      { order: 3, action: 'Verificar dependências (DB, Redis, rede)', command: 'Verificar conectividade com dependências' },
      { order: 4, action: 'Tentar reiniciar o serviço', command: 'systemctl restart <service>' },
      { order: 5, action: 'Se falhar, verificar recursos (RAM, disco)', command: 'free -m && df -h' },
    ],
    risk: 'low',
    auto_ok: true,
    estimated_time_minutes: 10,
  },
  {
    id: 'pb_cert_expiring',
    title: 'Certificado SSL expirando — Renovação',
    triggers: [
      { check_type: 'ssl_cert', severity: ['warning', 'critical'] },
    ],
    steps: [
      { order: 1, action: 'Verificar data de expiração', command: 'echo | openssl s_client -connect <host>:443 2>/dev/null | openssl x509 -noout -dates' },
      { order: 2, action: 'Se Let\'s Encrypt, renovar', command: 'certbot renew --dry-run && certbot renew' },
      { order: 3, action: 'Se certificado manual, gerar novo CSR', command: 'openssl req -new -newkey rsa:2048 -nodes -keyout <domain>.key -out <domain>.csr' },
      { order: 4, action: 'Instalar novo certificado', command: 'Substituir arquivos .crt e .key, reiniciar serviço web' },
      { order: 5, action: 'Verificar cadeia completa', command: 'openssl s_client -connect <host>:443 -showcerts' },
    ],
    risk: 'low',
    auto_ok: false,
    estimated_time_minutes: 30,
  },
  {
    id: 'pb_docker_container_down',
    title: 'Container Docker parado — Recuperação',
    triggers: [
      { source: 'docker', status: ['down', 'exited'] },
    ],
    steps: [
      { order: 1, action: 'Verificar status do container', command: 'docker ps -a --filter name=<container>' },
      { order: 2, action: 'Verificar logs do container', command: 'docker logs --tail 100 <container>' },
      { order: 3, action: 'Verificar uso de recursos', command: 'docker stats --no-stream <container>' },
      { order: 4, action: 'Reiniciar container', command: 'docker restart <container>' },
      { order: 5, action: 'Se falhar, verificar compose file e recriar', command: 'docker compose up -d <service>' },
    ],
    risk: 'low',
    auto_ok: true,
    estimated_time_minutes: 5,
  },
  {
    id: 'pb_database_slow',
    title: 'Banco de dados lento — Diagnóstico',
    triggers: [
      { target_type: 'database', severity: ['warning', 'critical'] },
    ],
    steps: [
      { order: 1, action: 'Verificar conexões ativas', command: 'PostgreSQL: SELECT count(*) FROM pg_stat_activity' },
      { order: 2, action: 'Verificar queries lentas', command: 'PostgreSQL: SELECT query, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10' },
      { order: 3, action: 'Verificar locks', command: 'PostgreSQL: SELECT * FROM pg_locks WHERE NOT granted' },
      { order: 4, action: 'Verificar uso de índices', command: 'PostgreSQL: SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0' },
      { order: 5, action: 'Verificar vacuum e autovacuum', command: 'PostgreSQL: SELECT relname, last_vacuum, last_autovacuum FROM pg_stat_user_tables' },
    ],
    risk: 'medium',
    auto_ok: false,
    estimated_time_minutes: 30,
  },
  {
    id: 'pb_redis_memory',
    title: 'Redis — Memória alta ou OOM',
    triggers: [
      { target_type: 'cache', severity: ['warning', 'critical'] },
      { check_type: 'redis_memory', severity: ['warning', 'critical'] },
    ],
    steps: [
      { order: 1, action: 'Verificar uso de memória', command: 'redis-cli INFO memory | grep used_memory_human' },
      { order: 2, action: 'Verificar maxmemory configurado', command: 'redis-cli CONFIG GET maxmemory' },
      { order: 3, action: 'Verificar política de evicção', command: 'redis-cli CONFIG GET maxmemory-policy' },
      { order: 4, action: 'Verificar chaves grandes', command: 'redis-cli --bigkeys' },
      { order: 5, action: 'Aumentar maxmemory ou ajustar política para allkeys-lru', command: 'redis-cli CONFIG SET maxmemory 2gb && redis-cli CONFIG SET maxmemory-policy allkeys-lru' },
    ],
    risk: 'medium',
    auto_ok: false,
    estimated_time_minutes: 20,
  },
  {
    id: 'pb_dns_resolution',
    title: 'Falha de resolução DNS',
    triggers: [
      { check_type: 'dns', severity: ['critical', 'warning'] },
    ],
    steps: [
      { order: 1, action: 'Testar resolução DNS', command: 'nslookup google.com 8.8.8.8' },
      { order: 2, action: 'Verificar /etc/resolv.conf', command: 'cat /etc/resolv.conf' },
      { order: 3, action: 'Verificar status do systemd-resolved', command: 'systemctl status systemd-resolved' },
      { order: 4, action: 'Verificar conectividade com DNS server', command: 'ping -c 3 <dns_server_ip>' },
      { order: 5, action: 'Reiniciar resolved se necessário', command: 'systemctl restart systemd-resolved' },
      { order: 6, action: 'Fallback: adicionar DNS público temporário', command: 'echo "nameserver 8.8.8.8" >> /etc/resolv.conf' },
    ],
    risk: 'medium',
    auto_ok: false,
    estimated_time_minutes: 15,
  },
  {
    id: 'pb_ntp_time_sync',
    title: 'Sincronização NTP — Relógio dessincronizado',
    triggers: [
      { check_type: 'ntp_time', severity: ['critical', 'warning'] },
    ],
    steps: [
      { order: 1, action: 'Verificar diferença de tempo', command: 'chronyc tracking 2>/dev/null || ntpq -p' },
      { order: 2, action: 'Verificar status do chronyd/ntpd', command: 'systemctl status chronyd || systemctl status ntpd' },
      { order: 3, action: 'Forçar sincronização imediata', command: 'chronyc makestep 2>/dev/null || ntpdate -u pool.ntp.org' },
      { order: 4, action: 'Verificar fontes NTP configuradas', command: 'chronyc sources 2>/dev/null || ntpq -p' },
      { order: 5, action: 'Reiniciar serviço NTP', command: 'systemctl restart chronyd || systemctl restart ntpd' },
    ],
    risk: 'low',
    auto_ok: true,
    estimated_time_minutes: 10,
  },
  {
    id: 'pb_network_interface',
    title: 'Interface de rede com erros — Diagnóstico',
    triggers: [
      { check_type: 'network', severity: ['warning', 'critical'] },
    ],
    steps: [
      { order: 1, action: 'Verificar erros nas interfaces', command: 'ip -s link show' },
      { order: 2, action: 'Verificar collisions e dropped packets', command: 'netstat -i' },
      { order: 3, action: 'Verificar duplex e velocidade', command: 'ethtool <interface>' },
      { order: 4, action: 'Verificar logs do kernel por erros de rede', command: 'dmesg | grep -i "eth\|net\|link"' },
      { order: 5, action: 'Trocar cabo de rede ou porta do switch', command: 'Físico: verificar LED da porta e testar outro cabo' },
    ],
    risk: 'medium',
    auto_ok: false,
    estimated_time_minutes: 25,
  },
  {
    id: 'pb_oom_killer',
    title: 'OOM Killer — Processo morto por falta de memória',
    triggers: [
      { check_type: 'memory', severity: ['critical'] },
    ],
    steps: [
      { order: 1, action: 'Verificar logs do OOM killer', command: 'dmesg | grep -i "oom\|killed"' },
      { order: 2, action: 'Verificar processos que mais consomem RAM', command: 'ps aux --sort=-%mem | head -15' },
      { order: 3, action: 'Verificar uso de swap', command: 'free -h' },
      { order: 4, action: 'Identificar memory leaks', command: 'Comparar uso de RAM dos processos ao longo do tempo (pmap, smem)' },
      { order: 5, action: 'Reiniciar serviço afetado', command: 'systemctl restart <service>' },
      { order: 6, action: 'Se recorrente: aumentar RAM, configurar limites de memória em containers', command: 'docker update --memory 2g --memory-swap 3g <container>' },
    ],
    risk: 'high',
    auto_ok: false,
    estimated_time_minutes: 30,
  },
];

// ─── Solution Index ─────────────────────────────────────────────────────────

/**
 * Busca playbooks relevantes para um incidente.
 */
function findPlaybooks(incident) {
  const matches = [];

  for (const pb of PLAYBOOKS) {
    let score = 0;
    let maxScore = 0;

    for (const trigger of pb.triggers) {
      // check_type match
      if (trigger.check_type) {
        maxScore += 1;
        if (incident.check_type === trigger.check_type) score += 1;
      }

      // severity match
      if (trigger.severity) {
        maxScore += 1;
        if (trigger.severity.includes(incident.severity)) score += 1;
      }

      // status match
      if (trigger.status) {
        maxScore += 1;
        if (trigger.status.includes(incident.status)) score += 1;
      }

      // target_type match
      if (trigger.target_type) {
        maxScore += 1;
        if (trigger.target_type.includes(incident.target_type)) score += 1;
      }

      // source match
      if (trigger.source) {
        maxScore += 1;
        if (incident.source === trigger.source) score += 1;
      }
    }

    if (score > 0 && maxScore > 0) {
      matches.push({
        playbook: pb,
        relevance: Math.round((score / maxScore) * 100) / 100,
        match_count: score,
      });
    }
  }

  return matches.sort((a, b) => b.relevance - a.relevance);
}

// ─── Feedback Loop ──────────────────────────────────────────────────────────

/**
 * Acumula feedback sobre remediações para melhorar sugestões futuras.
 */
class FeedbackLoop {
  constructor() {
    this.feedback = [];
  }

  record(incidentId, remediationId, rating, comment = null) {
    this.feedback.push({
      incident_id: incidentId,
      remediation_id: remediationId,
      rating, // 1 = positive, -1 = negative, 0 = neutral
      comment,
      timestamp: new Date().toISOString(),
    });
  }

  getEffectiveness(remediationId) {
    const relevant = this.feedback.filter(f => f.remediation_id === remediationId);
    if (relevant.length === 0) return null;

    const positive = relevant.filter(f => f.rating === 1).length;
    const negative = relevant.filter(f => f.rating === -1).length;

    return {
      total: relevant.length,
      positive,
      negative,
      success_rate: relevant.length > 0 ? positive / relevant.length : 0,
    };
  }

  getStats() {
    const byRemediation = {};
    for (const f of this.feedback) {
      if (!byRemediation[f.remediation_id]) {
        byRemediation[f.remediation_id] = { positive: 0, negative: 0, total: 0 };
      }
      byRemediation[f.remediation_id].total++;
      if (f.rating === 1) byRemediation[f.remediation_id].positive++;
      if (f.rating === -1) byRemediation[f.remediation_id].negative++;
    }

    const overall = {
      total: this.feedback.length,
      positive: this.feedback.filter(f => f.rating === 1).length,
      negative: this.feedback.filter(f => f.rating === -1).length,
    };

    return {
      overall,
      by_remediation: byRemediation,
      success_rate: overall.total > 0 ? overall.positive / overall.total : 0,
    };
  }
}

module.exports = {
  PLAYBOOKS,
  findPlaybooks,
  FeedbackLoop,
};
