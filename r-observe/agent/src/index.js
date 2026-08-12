'use strict';

const express = require('express');
const helmet = require('helmet');
const Docker = require('dockerode');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { createLifecycle } = require('../shared/lifecycle');
const { signInternalToken } = require('@results/auth');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const API_URL = process.env.API_URL || 'http://observe-api:3000';
const API_BASE_PATH = process.env.API_BASE_PATH || '/observe/api';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);
const DISK_WARN_PERCENT = parseInt(process.env.DISK_WARN_PERCENT || '80', 10);
const AGENT_ID = process.env.AGENT_ID || 'local-agent-01';
const AGENT_HOST_ADDRESS = process.env.AGENT_HOST_ADDRESS || '';
const DOCKER_PROJECTS = (process.env.OBSERVE_DOCKER_PROJECTS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const DOCKER_IGNORE_CONTAINERS = (process.env.OBSERVE_DOCKER_IGNORE_CONTAINERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ─── Config: checks externos ──────────────────────────────────────────────────
// Formato OBSERVE_HTTP_CHECKS: "label=url,label=url,..."
// Ex: "secure-httpd=https://10.10.2.30,grafana=http://observe-grafana:3000/api/health"
const HTTP_CHECKS = (process.env.OBSERVE_HTTP_CHECKS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(entry => {
    const idx = entry.indexOf('=');
    if (idx === -1) return null;
    return { label: entry.slice(0, idx), url: entry.slice(idx + 1) };
  })
  .filter(Boolean);

// Formato OBSERVE_TCP_CHECKS: "label=host:port,label=host:port,..."
// Ex: "postfix-mx1=10.10.2.3:25,dovecot-imaps=10.10.2.3:993,mariadb=10.10.2.99:3306"
const TCP_CHECKS = (process.env.OBSERVE_TCP_CHECKS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(entry => {
    const idx = entry.indexOf('=');
    if (idx === -1) return null;
    const label = entry.slice(0, idx);
    const target = entry.slice(idx + 1);
    const lastColon = target.lastIndexOf(':');
    if (lastColon === -1) return null;
    const host = target.slice(0, lastColon);
    const port = parseInt(target.slice(lastColon + 1), 10);
    if (!host || isNaN(port)) return null;
    return { label, host, port };
  })
  .filter(Boolean);

// Formato OBSERVE_STATIC_HOSTS: JSON array de objetos
// Ex: '[{"name":"mariadb","address":"10.10.2.99"},{"name":"ns1","address":"10.10.2.1"}]'
let STATIC_HOSTS = [];
try {
  STATIC_HOSTS = JSON.parse(process.env.OBSERVE_STATIC_HOSTS || '[]');
  if (!Array.isArray(STATIC_HOSTS)) STATIC_HOSTS = [];
} catch {
  STATIC_HOSTS = [];
}

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, msg, extra = {}) {
  if (level === 'debug' && LOG_LEVEL !== 'debug') return;
  process.stdout.write(JSON.stringify({ level, service: 'r-observe-agent', msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

// ─── Docker client (read-only via socket) ────────────────────────────────────
let docker = null;
try {
  docker = new Docker({ socketPath: '/var/run/docker.sock' });
} catch (e) {
  log('warn', 'Docker socket not available', { err: e.message });
}

// ─── Metrics state ───────────────────────────────────────────────────────────
let lastCheckAt = null;
let checkCount = 0;
let eventsSent = 0;
const checkStates = new Map();

// ─── Send event to API ────────────────────────────────────────────────────────
async function sendEvent(type, data) {
  try {
    const resp = await fetch(`${API_URL}${API_BASE_PATH}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': signInternalToken({ sub: 'r-observe-agent', service: 'agent', role: 'operator', aud: 'api', scope: ['api:access', 'api:events:write'] }),
      },
      body: JSON.stringify({
        type,
        source: 'r-observe-agent',
        agent_id: AGENT_ID,
        host: AGENT_ID,
        ...data,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      eventsSent++;
      log('debug', 'Event sent', { type });
    } else {
      log('warn', 'Event rejected', { type, status: resp.status });
    }
  } catch (e) {
    log('warn', 'Failed to send event', { type, err: e.message });
  }
}

async function publishCheckState(key, ok, failure) {
  const previous = checkStates.get(key);
  checkStates.set(key, ok);
  if (!ok && previous !== false) {
    await sendEvent(failure.type, failure.data);
  } else if (ok && previous === false) {
    await sendEvent('check.recovery', {
      check: failure.data.check,
      target: failure.data.target,
      message: `${failure.data.check.toUpperCase()} check recuperado: ${failure.data.target}`,
    });
  }
}

async function postInventory(containers) {
  try {
    const resp = await fetch(`${API_URL}${API_BASE_PATH}/inventory/docker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': signInternalToken({ sub: 'r-observe-agent', service: 'agent', role: 'admin', aud: 'api', scope: ['api:access', 'api:inventory:write'] }),
      },
      body: JSON.stringify({
        agent_id: AGENT_ID,
        host: AGENT_ID,
        address: AGENT_HOST_ADDRESS || null,
        containers,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      log('warn', 'Inventory rejected', { status: resp.status });
      return;
    }
    log('debug', 'Inventory synced', { containers: containers.length });
  } catch (e) {
    log('warn', 'Failed to sync inventory', { err: e.message });
  }
}

function containerHealth(container) {
  const health = container.Labels?.['com.docker.compose.healthcheck'] || '';
  if (container.Status?.includes('(healthy)')) return 'healthy';
  if (container.Status?.includes('(unhealthy)')) return 'unhealthy';
  if (container.Status?.includes('health: starting')) return 'starting';
  return health || null;
}

function normalizePorts(ports = []) {
  return ports.map(p => ({
    private_port: p.PrivatePort,
    public_port: p.PublicPort || null,
    type: p.Type || null,
    ip: p.IP || null,
  }));
}

function normalizeNetworks(networks = {}) {
  const out = {};
  for (const [name, cfg] of Object.entries(networks)) {
    out[name] = {
      ip_address: cfg?.IPAddress || null,
      aliases: cfg?.Aliases || [],
    };
  }
  return out;
}

function projectAllowed(composeProject) {
  return DOCKER_PROJECTS.length === 0 || DOCKER_PROJECTS.includes(composeProject || '');
}

function containerIgnored(name) {
  return DOCKER_IGNORE_CONTAINERS.includes(name);
}

// ─── Checks ───────────────────────────────────────────────────────────────────

// Check: Docker daemon
async function checkDockerDaemon() {
  if (!docker) return;
  try {
    await docker.ping();
    log('debug', 'Docker daemon: OK');
  } catch (e) {
    log('warn', 'Docker daemon unreachable', { err: e.message });
    await sendEvent('docker.daemon.down', { severity: 'critical', message: e.message });
  }
}

// Check: containers parados / unhealthy
async function checkContainers() {
  if (!docker) return;
  try {
    const containers = await docker.listContainers({ all: true });
    const inventory = [];
    for (const c of containers) {
      const name = (c.Names[0] || '').replace(/^\//, '');
      const composeProject = c.Labels?.['com.docker.compose.project'] || '';
      const composeService = c.Labels?.['com.docker.compose.service'] || '';
      if (!projectAllowed(composeProject)) continue;

      const ignored = containerIgnored(name);
      if (projectAllowed(composeProject)) {
        inventory.push({
          id: c.Id.slice(0, 12),
          name,
          image: c.Image,
          state: c.State,
          status: c.Status,
          health: containerHealth(c),
          compose_project: composeProject || null,
          compose_service: composeService || null,
          ports: normalizePorts(c.Ports),
          networks: normalizeNetworks(c.NetworkSettings?.Networks || {}),
          ignored,
        });
      }
      if (ignored) continue;
      if (c.State === 'exited' || c.State === 'dead') {
        log('warn', 'Container stopped', { name, state: c.State });
        await sendEvent('container.stopped', {
          severity: 'warning',
          service: name,
          container_id: c.Id.slice(0, 12),
          state: c.State,
          image: c.Image,
          message: `Container ${name} está ${c.State}`,
        });
      }
      // Healthcheck failing
      if (c.Status && c.Status.includes('unhealthy')) {
        log('warn', 'Container unhealthy', { name });
        await sendEvent('container.unhealthy', {
          severity: 'warning',
          service: name,
          container_id: c.Id.slice(0, 12),
          status: c.Status,
          message: `Container ${name} healthcheck failing`,
        });
      }
    }
    await postInventory(inventory);
  } catch (e) {
    log('error', 'Container check failed', { err: e.message });
  }
}

// Check: uso de disco
async function checkDisk() {
  try {
    const { stdout } = await execFileAsync('df', ['-h', '/'], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    // Linha 1: cabeçalho, linha 2: dados
    const data = lines[1]?.split(/\s+/);
    if (!data) return;
    const usedPercent = parseInt((data[4] || '0').replace('%', ''), 10);
    const filesystem = data[0];
    const used = data[2];
    const avail = data[3];
    log('debug', 'Disk check', { filesystem, usedPercent });
    if (usedPercent >= DISK_WARN_PERCENT) {
      await sendEvent('disk.high_usage', {
        severity: usedPercent >= 95 ? 'critical' : 'warning',
        filesystem,
        used,
        avail,
        percent: usedPercent,
        message: `Disco ${filesystem} em ${usedPercent}% de uso`,
      });
    }
  } catch (e) {
    log('warn', 'Disk check failed', { err: e.message });
  }
}

// Check: HTTP health de um endpoint
async function checkHTTP(url, label) {
  const target = label || url;
  const key = `http:${target}`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      await publishCheckState(key, false, {
        type: 'check.failed',
        data: {
          severity: 'warning',
          check: 'http',
          target,
          status_code: resp.status,
          message: `HTTP check falhou: ${url} retornou ${resp.status}`,
        },
      });
    } else {
      await publishCheckState(key, true, { type: 'check.failed', data: { check: 'http', target } });
    }
  } catch (e) {
    await publishCheckState(key, false, {
      type: 'check.failed',
      data: {
        severity: 'warning',
        check: 'http',
        target,
        message: `HTTP check inacessível: ${url} — ${e.message}`,
      },
    });
  }
}

// Check: TCP port de um serviço externo
function checkTCP(host, port, label) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;

    const finish = async (ok, errMsg) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (!ok) {
        await sendEvent('check.tcp.failed', {
          severity: 'warning',
          check: 'tcp',
          target: label,
          host,
          port,
          message: `TCP check falhou: ${label} (${host}:${port}) — ${errMsg}`,
        }).catch(() => {});
      } else {
        log('debug', 'TCP check OK', { label, host, port });
      }
      resolve();
    };

    sock.setTimeout(5000);
    sock.connect(port, host, () => finish(true, null));
    sock.on('timeout', () => finish(false, 'timeout'));
    sock.on('error', (e) => finish(false, e.message));
  });
}

// Registro de hosts externos / estáticos na API
async function postStaticHosts() {
  for (const h of STATIC_HOSTS) {
    if (!h.name || !h.address) continue;
    // Valida nome (mesma regex da API)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(h.name)) {
      log('warn', 'Static host name inválido, ignorado', { name: h.name });
      continue;
    }
    try {
      const resp = await fetch(`${API_URL}${API_BASE_PATH}/hosts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-token': signInternalToken({ sub: 'r-observe-agent', service: 'agent', role: 'admin', aud: 'api', scope: ['api:access', 'api:inventory:write'] }),
        },
        body: JSON.stringify({
          name: h.name,
          address: h.address,
          display_name: h.display_name || h.name,
          vars: h.vars || {},
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        log('debug', 'Static host upserted', { name: h.name, address: h.address });
      } else {
        log('warn', 'Static host upsert failed', { name: h.name, status: resp.status });
      }
    } catch (e) {
      log('warn', 'Failed to register static host', { name: h.name, err: e.message });
    }
  }
}

// Check: volumes órfãos (apenas conta — não remove nunca)
async function checkOrphanVolumes() {
  if (!docker) return;
  try {
    const { Volumes } = await docker.listVolumes({ filters: { dangling: ['true'] } });
    if (Volumes && Volumes.length > 0) {
      log('info', 'Orphan volumes found', { count: Volumes.length });
      // Apenas reporta, não remove
      await sendEvent('docker.orphan_volumes', {
        severity: 'info',
        count: Volumes.length,
        names: Volumes.slice(0, 10).map(v => v.Name),
        message: `${Volumes.length} volume(s) órfão(s) detectado(s)`,
      });
    }
  } catch (e) {
    log('warn', 'Orphan volume check failed', { err: e.message });
  }
}

// ─── Run all checks ───────────────────────────────────────────────────────────
async function runChecks() {
  log('debug', 'Running checks...');
  checkCount++;
  lastCheckAt = new Date().toISOString();

  await Promise.allSettled([
    checkDockerDaemon(),
    checkContainers(),
    checkDisk(),
    checkOrphanVolumes(),
    // HTTP check da própria API para validar conectividade
    checkHTTP(`${API_URL}${API_BASE_PATH}/health`, 'r-observe-api'),
    // HTTP checks externos configuráveis (OBSERVE_HTTP_CHECKS)
    ...HTTP_CHECKS.map(({ label, url }) => checkHTTP(url, label)),
    // TCP checks externos configuráveis (OBSERVE_TCP_CHECKS)
    ...TCP_CHECKS.map(({ label, host, port }) => checkTCP(host, port, label)),
    // Registro de hosts estáticos/externos (OBSERVE_STATIC_HOSTS)
    postStaticHosts(),
  ]);

  log('debug', 'Checks complete', { checkCount });
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'r-observe-agent',
    agent_id: AGENT_ID,
    checkCount,
    eventsSent,
    lastCheckAt,
    version: '0.1.0',
    checks: {
      http: HTTP_CHECKS.map(c => c.label),
      tcp: TCP_CHECKS.map(c => `${c.label}(${c.host}:${c.port})`),
      static_hosts: STATIC_HOSTS.map(h => h.name),
    },
  });
});

app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain');
  res.end([
    `# HELP r_observe_agent_checks_total Total check cycles run`,
    `# TYPE r_observe_agent_checks_total counter`,
    `r_observe_agent_checks_total ${checkCount}`,
    `# HELP r_observe_agent_events_sent_total Total events sent to API`,
    `# TYPE r_observe_agent_events_sent_total counter`,
    `r_observe_agent_events_sent_total ${eventsSent}`,
  ].join('\n') + '\n');
});

// Trigger manual check (para uso em smoke tests)
app.post('/checks/run', (_req, res) => {
  runChecks().catch((e) => log('error', 'Manual check failed', { err: e.message }));
  res.json({ accepted: true, message: 'Check cycle initiated' });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', `Agent listening on :${PORT}`, { agent_id: AGENT_ID, interval_ms: CHECK_INTERVAL_MS });
  // Inicia loop de checks
  runChecks().catch((e) => log('error', 'Initial check failed', { err: e.message }));
  setInterval(() => {
    runChecks().catch((e) => log('error', 'Check interval failed', { err: e.message }));
  }, CHECK_INTERVAL_MS);
});

const lifecycle = createLifecycle({ label: 'r-observe-agent', log });
lifecycle.onServer(server);
lifecycle.start();
