'use strict';

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_SD_PATH = process.env.DISCOVERY_SD_FILE || '/app/data/prometheus-discovery.json';

function toPromSdGroups(assets) {
  // Exporters monitorados via static config (Docker DNS names) — não gerar via SD.
  // 'prometheus' incluído pois já tem job prometheus-self/prometheus no prometheus.yml
  // e IPs Docker mudam a cada restart, gerando targets DOWN obsoletos.
  const STATIC_EXPORTER_JOBS = new Set([
    'redis-exporter', 'postgres-exporter', 'cadvisor', 'mysql-exporter',
    'mongodb-exporter', 'elasticsearch-exporter', 'prometheus',
  ]);

  const groups = [];
  for (const a of assets) {
    // ── Service exporters (node, prometheus, etc.) ───────────────────────
    if (Array.isArray(a.services)) {
      for (const s of a.services) {
        if (!s.exporter_target) continue;
        // Pular sidecar exporters (já têm static job no Prometheus)
        if (STATIC_EXPORTER_JOBS.has(s.job)) continue;
        groups.push({
          targets: [s.exporter_target],
          labels: {
            job: s.job || 'discovered',
            tenant_id: a.tenant_id,
            site_id: a.site_id,
            edge_id: a.edge_id || 'central',
            discovered: 'true',
            asset: a.asset_name,
          },
        });
      }
    }

    // ── SNMP exporter (camada física L1) ─────────────────────────────────
    const hasSnmp = a.services?.some(s => s.port === 161)
      || a.snmp_interfaces?.length
      || a.metadata?.scan?.snmp_interfaces?.length
      || a.metadata?.snmp_interfaces?.length;
    if (hasSnmp && a.primary_ip) {
      groups.push({
        targets: [a.primary_ip],
        labels: {
          job: 'snmp-exporter',
          tenant_id: a.tenant_id,
          site_id: a.site_id,
          edge_id: a.edge_id || 'central',
          discovered: 'true',
          asset: a.asset_name || a.primary_ip,
          __param_module: 'if_mib',
        },
      });
    }
  }
  return groups;
}

async function writeFileSd(assets) {
  const groups = toPromSdGroups(assets);
  await fs.mkdir(path.dirname(DEFAULT_SD_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_SD_PATH, JSON.stringify(groups, null, 2));
  return { path: DEFAULT_SD_PATH, total: groups.length };
}

module.exports = { writeFileSd, toPromSdGroups };
