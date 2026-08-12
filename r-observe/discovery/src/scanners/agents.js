'use strict';

// Remote Agents Architecture para R-Observe Discovery (Enterprise).
//
// Permite que agentes remotos em outras maquinas/subnets enviem descobertas
// para o discovery central. Arquitetura:
//
//   [Agent Host A] ──HTTP POST──→ [Discovery Central API]
//   [Agent Host B] ──HTTP POST──→ [Discovery Central API]
//   [Agent Host C] ──HTTP POST──→ [Discovery Central API]
//
// Cada agente executa um subset de scanners localmente e reporta:
// - ARP table local
// - Ping sweep da subnet local
// - Docker/K8s containers locais
// - Passive listeners locais (mDNS, SSDP, DHCP)
// - Windows/SMB na subnet
//
// Transporte: HTTP REST com token de autenticacao.
// Registro: agentes se registram ao iniciar e enviam heartbeat.

const { log } = require('../utils/logger');
const { signInternalToken } = require('@results/auth');
const { runWithTenant } = require('../shared/tenant-context');
const fs = require('fs');

// ── Agente: heartbeat e registro ─────────────────────────────────────────

const AGENT_API_URL = process.env.DISCOVERY_AGENT_API_URL || 'http://r-observe-discovery:3010';
const AGENT_ID = process.env.DISCOVERY_AGENT_ID || `agent-${require('os').hostname()}`;
const AGENT_HEARTBEAT_MS = parseInt(process.env.DISCOVERY_AGENT_HEARTBEAT_MS || '60000', 10);

// Registra o agente no discovery central.
async function registerAgent({ agentId, hostname, subnets, capabilities }) {
  try {
    const resp = await fetch(`${AGENT_API_URL}/api/discovery/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': signInternalToken({ sub: 'r-observe-discovery-agent', service: 'discovery', role: 'operator', aud: 'discovery', scope: ['discovery:access', 'discovery:write'] }),
      },
      body: JSON.stringify({
        agent_id: agentId || AGENT_ID,
        hostname: hostname || require('os').hostname(),
        subnets: subnets || [],
        capabilities: capabilities || detectCapabilities(),
        version: '1.0.0',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      log('warn', 'Agent registration failed', { status: resp.status });
      return false;
    }

    log('info', 'Agent registered', { agent_id: AGENT_ID });
    return true;
  } catch (e) {
    log('warn', 'Agent registration error', { err: e.message });
    return false;
  }
}

// Heartbeat periodico para manter o registro ativo.
async function sendHeartbeat({ agentId }) {
  try {
    const resp = await fetch(`${AGENT_API_URL}/api/discovery/agents/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': signInternalToken({ sub: 'r-observe-discovery-agent', service: 'discovery', role: 'operator', aud: 'discovery', scope: ['discovery:access', 'discovery:write'] }),
      },
      body: JSON.stringify({
        agent_id: agentId || AGENT_ID,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });

    return resp.ok;
  } catch {
    return false;
  }
}

// Detecta capacidades do agente local.
function detectCapabilities() {
  const caps = [];
  const commandCapabilities = [
    { capability: 'icmp', names: ['ping'] },
    { capability: 'k8s', names: ['kubectl'] },
    { capability: 'bluetooth', names: ['hcitool'] },
    { capability: 'lldp', names: ['lldpcli'] },
    { capability: 'docker', names: ['docker'] },
    { capability: 'arp', names: ['ip'] },
  ];
  const searchDirs = ['/usr/local/bin', '/usr/bin', '/usr/sbin', '/bin', '/sbin'];
  for (const item of commandCapabilities) {
    const available = item.names.some(name => searchDirs.some(dir => {
      try {
        fs.accessSync(`${dir}/${name}`, fs.constants.X_OK);
        return true;
      } catch (_) {
        return false;
      }
    }));
    if (available) caps.push(item.capability);
  }

  // Sempre tem TCP
  caps.push('tcp');
  caps.push('http');

  return caps;
}

// ── Agente: scan local e report ──────────────────────────────────────────

// Executa scan local rapido (ARP + ping sweep da subnet) e reporta.
async function runLocalScan({ agentId, subnets }) {
  const findings = [];
  const assets = [];

  try {
    // 1. ARP table local
    try {
      const { discoverArpTable, enrichArpAssets } = require('./arp-discovery');
      const arp = enrichArpAssets(await discoverArpTable());
      for (const a of arp) {
        assets.push({
          asset_key: a.mac_address ? `mac:${a.mac_address}` : `ip:${a.primary_ip}`,
          asset_name: a.device_name || a.primary_ip,
          primary_ip: a.primary_ip,
          mac: a.mac_address,
          vendor: a.vendor,
          source: 'agent-arp',
        });
      }
    } catch (e) {
      log('warn', 'Agent ARP scan failed', { err: e.message });
    }

    // 2. Docker containers locais
    try {
      const { discoverLocalDocker } = require('./docker-local');
      const containers = await discoverLocalDocker();
      for (const c of containers) {
        findings.push({
          type: 'agent_docker_container',
          source: 'agent-docker',
          payload: c,
        });
      }
    } catch (_) {}

    // 3. Ping sweep das subnets locais
    if (subnets && subnets.length > 0) {
      try {
        const { pingSweep } = require('./ping-sweep');
        for (const subnet of subnets) {
          const { expandSubnetToHosts } = require('./ping-sweep');
          const hosts = expandSubnetToHosts(subnet);
          if (hosts.length > 0 && hosts.length <= 256) {
            const alive = await pingSweep(hosts, { maxParallel: 30 });
            for (const h of alive) {
              findings.push({
                type: 'agent_icmp_host',
                source: 'agent-ping',
                payload: h,
              });
            }
          }
        }
      } catch (e) {
        log('warn', 'Agent ping sweep failed', { err: e.message });
      }
    }
  } catch (e) {
    log('warn', 'Agent local scan failed', { err: e.message });
  }

  return { assets, findings };
}

// Reporta resultados do scan local para o discovery central.
async function reportScanResults({ agentId, assets, findings }) {
  try {
    const resp = await fetch(`${AGENT_API_URL}/api/discovery/agents/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': signInternalToken({ sub: 'r-observe-discovery-agent', service: 'discovery', role: 'operator', aud: 'discovery', scope: ['discovery:access', 'discovery:write'] }),
      },
      body: JSON.stringify({
        agent_id: agentId || AGENT_ID,
        assets: assets || [],
        findings: findings || [],
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      log('warn', 'Agent scan report failed', { status: resp.status });
      return false;
    }

    log('info', 'Agent scan reported', { assets: assets?.length || 0, findings: findings?.length || 0 });
    return true;
  } catch (e) {
    log('warn', 'Agent scan report error', { err: e.message });
    return false;
  }
}

// ── Loop do agente ───────────────────────────────────────────────────────

function startAgent({ subnets, scanIntervalMs }) {
  const interval = scanIntervalMs || AGENT_HEARTBEAT_MS * 5; // scan a cada 5 heartbeats

  log('info', 'Remote agent started', { agent_id: AGENT_ID, heartbeat_ms: AGENT_HEARTBEAT_MS, scan_interval_ms: interval });

  // Heartbeat periodico
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat({ agentId: AGENT_ID });
  }, AGENT_HEARTBEAT_MS);

  // Scan local periodico
  const scanTimer = setInterval(async () => {
    const { assets, findings } = await runLocalScan({ agentId: AGENT_ID, subnets });
    await reportScanResults({ agentId: AGENT_ID, assets, findings });
  }, interval);

  // Registro inicial + primeiro scan
  registerAgent({ agentId: AGENT_ID, subnets }).then(async (ok) => {
    if (ok) {
      const { assets, findings } = await runLocalScan({ agentId: AGENT_ID, subnets });
      await reportScanResults({ agentId: AGENT_ID, assets, findings });
    }
  });

  return () => {
    clearInterval(heartbeatTimer);
    clearInterval(scanTimer);
    log('info', 'Remote agent stopped', { agent_id: AGENT_ID });
  };
}

// ── Servidor: recebe reports de agentes ──────────────────────────────────

// Registra um agente no discovery central (chamado via API).
async function handleAgentRegister(db, body, scope = {}) {
  const { agent_id, hostname, subnets, capabilities, version } = body || {};

  const result = await db.query(
    `INSERT INTO observe_discovery_agents
      (id, tenant_id, site_id, edge_id, agent_id, hostname, subnets, capabilities, version, status, last_seen_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'online',NOW())
     ON CONFLICT (tenant_id, site_id, edge_id, agent_id)
     DO UPDATE SET hostname = EXCLUDED.hostname, subnets = EXCLUDED.subnets,
                   capabilities = EXCLUDED.capabilities, version = EXCLUDED.version,
                   status = 'online', last_seen_at = NOW(), updated_at = NOW()`,
    [scope.tenant_id || 'default', scope.site_id || 'default-site', scope.edge_id || 'central', agent_id, hostname,
     JSON.stringify(subnets || []), JSON.stringify(capabilities || []), version || '1.0.0']
  );

  return { registered: true, agent_id };
}

// Heartbeat do agente.
async function handleAgentHeartbeat(db, body, scope = {}) {
  const { agent_id } = body || {};
  const result = await db.query(
    `UPDATE observe_discovery_agents SET last_seen_at = NOW(), status = 'online', updated_at = NOW()
     WHERE agent_id = $1 AND tenant_id=$2 AND site_id=$3 AND edge_id=$4`,
    [agent_id, scope.tenant_id || 'default', scope.site_id || 'default-site', scope.edge_id || 'central']
  );
  return { heartbeat: result.rowCount > 0, agent_id };
}

// ── Offline detection: identifica agentes que pararam de responder ──────
const AGENT_OFFLINE_THRESHOLD_MS = parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10); // 5min default
let _offlineTimer = null;

async function detectOfflineAgentsForTenant(db, redis, tenantId) {
  return runWithTenant(tenantId, async () => {
  const threshold = new Date(Date.now() - AGENT_OFFLINE_THRESHOLD_MS);
  const result = await db.query(
    `SELECT tenant_id, site_id, edge_id, agent_id, hostname, last_seen_at, capabilities
     FROM observe_discovery_agents
     WHERE status = 'online' AND last_seen_at < $1`,
    [threshold.toISOString()]
  );

  const offline = result.rows || [];
  if (!offline.length) return { offline: 0 };

  for (const agent of offline) {
    await db.query(
      `UPDATE observe_discovery_agents
       SET status = 'offline', updated_at = NOW()
       WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND agent_id = $4`,
      [agent.tenant_id, agent.site_id, agent.edge_id, agent.agent_id]
    );
  }

  log('warn', 'Agents offline detected', {
    count: offline.length,
    agents: offline.map(a => a.agent_id),
    threshold_ms: AGENT_OFFLINE_THRESHOLD_MS,
  });

  // Emite eventos para cada agente offline
  try {
    if (redis) {
      for (const agent of offline) {
        await emitEvent(redis, 'observe.discovery.agent_offline', {
          agent_id: agent.agent_id,
          hostname: agent.hostname,
          last_seen: agent.last_seen_at,
          capabilities: agent.capabilities,
          tenant_id: agent.tenant_id,
          site_id: agent.site_id,
          edge_id: agent.edge_id,
          offline_duration_ms: Date.now() - new Date(agent.last_seen_at).getTime(),
        });
      }
    }
  } catch (e) {
    log('warn', 'Agent offline event emission failed', { err: e.message });
  }

  return { offline: offline.length, agents: offline.map(a => a.agent_id) };
  });
}

async function detectOfflineAgents(db, redis = null) {
  const tenants = await db.query(`SELECT id FROM observe_tenants WHERE status = 'active' ORDER BY id`);
  const detected = [];
  for (const tenant of tenants.rows) {
    const result = await detectOfflineAgentsForTenant(db, redis, tenant.id);
    detected.push(...(result.agents || []).map(agent_id => ({ tenant_id: tenant.id, agent_id })));
  }
  return { offline: detected.length, agents: detected };
}

function startOfflineDetection(db, redis = null, intervalMs = 60000) {
  if (_offlineTimer) return;
  _offlineTimer = setInterval(() => {
    detectOfflineAgents(db, redis).catch(e =>
      log('warn', 'Agent offline detection failed', { err: e.message })
    );
  }, intervalMs);
  _offlineTimer.unref();
  log('info', 'Agent offline detection started', { interval_ms: intervalMs, threshold_ms: AGENT_OFFLINE_THRESHOLD_MS });
}

function stopOfflineDetection() {
  if (_offlineTimer) { clearInterval(_offlineTimer); _offlineTimer = null; }
}

// Processa report de scan de agente remoto.
async function handleAgentReport({ db, redis, body }) {
  const { agent_id, assets, findings } = body || {};
  const scope = body.scope || { tenant_id: 'default', site_id: 'default-site', edge_id: 'central' };

  const dbConn = await db.connect();
  let accepted = 0;
  try {
  await dbConn.query('BEGIN');
  for (const asset of (assets || [])) {
    await dbConn.query(
      `INSERT INTO observe_assets
        (id, tenant_id, site_id, edge_id, asset_key, asset_name, primary_ip, asset_type, vendor, confidence, metadata)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'host',$7,0.7,$8)
       ON CONFLICT (tenant_id, site_id, edge_id, asset_key)
       DO UPDATE SET last_seen_at = NOW(), updated_at = NOW()`,
      [scope.tenant_id, scope.site_id, scope.edge_id, asset.asset_key, asset.asset_name, asset.primary_ip, asset.vendor || null,
       JSON.stringify({ source: 'agent', agent_id, ...asset })]
    );
    accepted++;
  }

  for (const finding of (findings || [])) {
    await dbConn.query(
      `INSERT INTO observe_discovery_findings
        (id, run_id, tenant_id, site_id, edge_id, finding_type, severity, source, asset_key, payload, observed_at)
       VALUES (gen_random_uuid(),NULL,$1,$2,$3,$4,'info',$5,$6,$7,NOW())`,
      [scope.tenant_id, scope.site_id, scope.edge_id, finding.type, `agent:${agent_id}`, finding.payload?.host || finding.asset_key || 'unknown',
       JSON.stringify({ ...finding, agent_id })]
    );
  }
  await dbConn.query('COMMIT');
  } catch (error) {
    try { await dbConn.query('ROLLBACK'); } catch (_) { /* preserva o erro original */ }
    throw error;
  } finally {
    dbConn.release();
  }

  // Emite eventos
  if (redis && accepted > 0) {
    const { emitEvent } = require('../queues/events');
    await emitEvent(redis, 'observe.discovery.agent_report', {
      agent_id,
      assets: assets?.length || 0,
      findings: findings?.length || 0,
    });
  }

  return { accepted_assets: accepted, total_findings: findings?.length || 0, agent_id };
}

module.exports = {
  // Agent side
  registerAgent,
  sendHeartbeat,
  runLocalScan,
  reportScanResults,
  startAgent,
  detectCapabilities,

  // Server side
  handleAgentRegister,
  handleAgentHeartbeat,
  handleAgentReport,
  detectOfflineAgents,
  detectOfflineAgentsForTenant,
  startOfflineDetection,
  stopOfflineDetection,
};
