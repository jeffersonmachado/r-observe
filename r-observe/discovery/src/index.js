'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const client = require('prom-client');

const { log } = require('./utils/logger');
const { runDiscovery } = require('./engine/discovery-engine');
const { createPassiveIngest } = require('./passive/ingest');
const { startPassiveReceivers } = require('./passive/receivers');
const { autoAttachAllNetworks } = require('./scanners/docker-local');
const { shortestPath, blastRadius, writeGraph: writeNeo4jGraph, enabled: neo4jEnabled, closeDriver: closeNeo4jDriver } = require('./topology/graph-store');
const { buildTopologyEdges } = require('./topology/engine');
const { fingerprintAsset } = require('./fingerprint/engine');
const { toPromSdGroups } = require('./exporters/prometheus-sd');
const { emitEvent } = require('./queues/events');
const { createQueueJob, parseQueueJob, createReliableListConsumer, queueStats } = require('./queues/reliable-list');
const { acquireScanAdmission, releaseScanAdmission, admissionFromJob } = require('./queues/scan-admission');
const { upsertAsset } = require('./engine/repository');
const { createDbClient } = require('./db');
const { requireJwt, requireScope } = require('@results/auth');
const { resolveTenantId, parseScope } = require('./auth/tenant-scope');
const { runWithTenant } = require('./shared/tenant-context');
const { createHttpErrorHandler } = require('./shared/http-error-handler');

const { createLifecycle } = require('./shared/lifecycle');
const { audit, logAudit } = require('./audit');
const { isValidHost, isValidPort } = require('./validators');
const { requireQuota } = require('./quotas');
const { startScheduler } = require('./schedulers/scan-scheduler');
const { startRetention } = require('./retention');
const { startRunRecovery } = require('./run-recovery');
const { calcNextRun } = require('./schedulers/scan-scheduler');
const { handleAgentRegister, handleAgentHeartbeat, handleAgentReport } = require('./scanners/agents');

const PORT = parseInt(process.env.PORT || '3010', 10);
const SCAN_QUEUE_ENABLED = process.env.DISCOVERY_SCAN_QUEUE_ENABLED !== 'false';
const DOCKER_DISCOVERY_ENABLED = process.env.DISCOVERY_DOCKER_ENABLED === 'true';
const PASSIVE_LISTENERS_ENABLED = process.env.DISCOVERY_PASSIVE_LISTENERS_ENABLED !== 'false';

// ── Progresso em memória da varredura atual ────────────────────────────────
const PIPELINE_STAGES = ['policy', 'run_create', 'targets', 'scanning', 'docker', 'topology', 'prometheus_sd', 'icinga', 'done'];

const _progressByScope = new Map();

function progressKey(scope = {}) {
  return `${scope.tenant_id || 'default'}:${scope.site_id || 'default-site'}:${scope.edge_id || 'central'}`;
}

function makeOnProgress(scope = {}) {
  const key = progressKey(scope);
  const startedAt = new Date().toISOString();
  const state = {
    active: true,
    run_id: null,
    started_at: startedAt,
    stage: 'policy',
    stages: Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 'pending'])),
    scanned: 0,
    total_targets: 0,
    discovered: 0,
    docker_found: 0,
    topology_edges: 0,
    summary: null,
  };
  _progressByScope.set(key, state);
  return (update) => {
    if (update.run_id) state.run_id = update.run_id;
    if (update.stage) state.stage = update.stage;
    if (update.status && update.stage) state.stages[update.stage] = update.status;
    if (update.scanned != null) state.scanned = update.scanned;
    if (update.total_targets != null) state.total_targets = update.total_targets;
    if (update.discovered != null) state.discovered = update.discovered;
    if (update.docker_found != null) state.docker_found = update.docker_found;
    if (update.topology_edges != null) state.topology_edges = update.topology_edges;
    if (update.summary) state.summary = update.summary;
    if (update.stage === 'done' && update.status === 'done') state.active = false;
    _progressByScope.set(key, { ...state });
    if (redis && state.run_id) {
      redis.set(`observe:discovery:progress:${state.run_id}`, JSON.stringify({ ...state, scope }), 'EX', 86400)
        .catch((e) => log('warn', 'Progress persistence failed', { err: e.message, run_id: state.run_id }));
    }
  };
}

const db = createDbClient(process.env);

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 }) : null;
if (redis) redis.connect().catch((e) => log('warn', 'Redis connect failed', { err: e.message }));
const queueRedis = redis ? redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null }) : null;
if (queueRedis) queueRedis.connect().catch((e) => log('warn', 'Redis queue connect failed', { err: e.message }));
const reliableQueueConsumer = queueRedis ? createReliableListConsumer(queueRedis) : null;

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const discoveryMetrics = require('./metrics');
for (const collector of Object.values(discoveryMetrics)) register.registerMetric(collector);
const runsTotal = new client.Counter({ name: 'r_observe_discovery_runs_total', help: 'Total discovery runs', labelNames: ['status'], registers: [register] });

const app = express();
app.locals.db = db;

const reactDir = path.dirname(require.resolve('react/package.json'));
const reactDomDir = path.dirname(require.resolve('react-dom/package.json'));
const d3Dir = path.resolve(path.dirname(require.resolve('d3')), '..', 'dist');
app.get('/observe/discovery/data/vendor/react.min.js', (_req, res) =>
  res.sendFile(path.join(reactDir, 'umd/react.production.min.js')));
app.get('/observe/discovery/data/vendor/react-dom.min.js', (_req, res) =>
  res.sendFile(path.join(reactDomDir, 'umd/react-dom.production.min.js')));
app.get('/observe/discovery/data/vendor/d3.min.js', (_req, res) =>
  res.sendFile(path.join(d3Dir, 'd3.min.js')));

let _vite = null;
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    if (_vite) return _vite.middlewares.handle(req, res, next);
    next();
  });
} else {
  app.use('/observe/discovery/data', express.static(path.join(__dirname, '../public')));
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

const requireAuth = (req, res, next) => {
  return requireJwt(req, res, () => {
    const requestedTenant = req.body?.tenant_id ?? req.query?.tenant_id;
    const tenantId = resolveTenantId(req.auth, requestedTenant);
    if (req.body && typeof req.body === 'object') req.body.tenant_id = tenantId;
    if (req.query && typeof req.query === 'object') req.query.tenant_id = tenantId;
    return runWithTenant(tenantId, next);
  });
};

const requireAuthOpt = requireAuth; // requireAuthOpt agora exige autenticação (security hardening)
const requireWrite = requireScope('discovery:write');
const requestScope = (req, input = {}) => parseScope(input || {}, req.auth || {});

// ── Audit middleware global: extrai actor/ip ──────────────────────────────
app.use(audit);

function validateScanInput(body = {}) {
  const validProfiles = ['safe', 'balanced', 'aggressive'];
  if (body.profile && !validProfiles.includes(body.profile)) {
    return 'profile inválido';
  }
  if (body.targets && !Array.isArray(body.targets)) {
    return 'targets deve ser array';
  }
  return null;
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ── Passive event ingestion (extraído para passive/ingest.js) ──────────────
const { ingestPassiveEvents } = createPassiveIngest({ db, redis, log, parseScope });

function validAgentId(value) {
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(String(value || ''));
}

function executableAvailable(name) {
  return String(process.env.PATH || '').split(path.delimiter).some((dir) => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

async function discoveryHealth() {
  let database = true;
  try { await db.query('SELECT 1'); } catch { database = false; }
  let redisOk = !redis;
  let scanQueue = { enabled: SCAN_QUEUE_ENABLED, pending: 0, processing: 0, dead_letter: 0, consumers: 0 };
  if (redis) {
    try {
      redisOk = await Promise.race([
        redis.ping().then((v) => v === 'PONG'),
        new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
    } catch { redisOk = false; }
    if (redisOk) {
      try {
        scanQueue = { enabled: SCAN_QUEUE_ENABLED, ...await queueStats(redis) };
        discoveryMetrics.queueDepth.set(scanQueue.pending);
        discoveryMetrics.queueProcessing.set(scanQueue.processing);
        discoveryMetrics.queueDeadLetter.set(scanQueue.dead_letter);
        discoveryMetrics.queueConsumers.set(scanQueue.consumers);
      } catch (_) {}
    }
  }
  const capabilities = {
    nmap: executableAvailable('nmap'),
    snmp: executableAvailable('snmpwalk') && executableAvailable('snmpget'),
    arp_scan: executableAvailable('arp-scan'),
    ping: executableAvailable('ping'),
    ssh_backup: executableAvailable('ssh') && executableAvailable('sshpass'),
    lldp: executableAvailable('lldpcli'),
    kubernetes: executableAvailable('kubectl'),
    bluetooth: executableAvailable('bluetoothctl'),
  };
  const requiredOk = database && (!SCAN_QUEUE_ENABLED || redisOk);
  return { httpStatus: requiredOk ? 200 : 503, body: {
    status: requiredOk ? 'ok' : 'degraded', service: 'r-observe-discovery', version: '0.1.0',
    dependencies: { database, redis: redisOk }, queue: scanQueue, capabilities,
  } };
}

app.get('/health', async (_req, res) => {
  const health = await discoveryHealth();
  res.status(health.httpStatus).json(health.body);
});

app.get('/api/discovery/health', async (_req, res) => {
  const health = await discoveryHealth();
  res.status(health.httpStatus).json(health.body);
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/api/discovery/progress', requireAuthOpt, asyncRoute(async (req, res) => {
  if (req.query.run_id && redis) {
    const raw = await redis.get(`observe:discovery:progress:${req.query.run_id}`);
    if (raw) {
      const persisted = JSON.parse(raw);
      const scope = requestScope(req, req.query);
      if (progressKey(persisted.scope) !== progressKey(scope)) return res.status(404).json({ error: 'not_found' });
      const elapsed_ms = Date.now() - new Date(persisted.started_at).getTime();
      return res.json({ ...persisted, elapsed_ms, persisted: true });
    }
  }
  const progress = _progressByScope.get(progressKey(requestScope(req, req.query)));
  if (!progress) return res.json({ active: false });
  const elapsed_ms = Date.now() - new Date(progress.started_at).getTime();
  res.json({ ...progress, elapsed_ms });
}));

app.post('/api/discovery/scan', requireAuth, requireWrite, requireQuota('scans'), asyncRoute(async (req, res) => {
  const err = validateScanInput(req.body || {});
  if (err) return res.status(400).json({ error: err });
  let payload = createQueueJob({ ...(req.body || {}), docker_discovery_enabled: DOCKER_DISCOVERY_ENABLED });
  const scanScope = requestScope(req, payload);
  const admission = redis
    ? await acquireScanAdmission(redis, scanScope, req._quota?.max_concurrent_scans || 1)
    : null;
  if (redis && !admission) {
    return res.status(429).json({ error: 'Quota exceeded', resource: 'concurrent_scans', max: req._quota?.max_concurrent_scans || 1 });
  }
  if (admission) payload = { ...payload, queue_admission_key: admission.key, queue_admission_token: admission.token };

  if (SCAN_QUEUE_ENABLED && redis) {
    try {
      await redis.rpush('observe:scan:network', JSON.stringify(payload));
      await redis.publish('observe:scan:network', JSON.stringify({ event: 'scan_enqueued', ts: new Date().toISOString() }));
    } catch (error) {
      await releaseScanAdmission(redis, admission).catch(() => {});
      throw error;
    }
    _progressByScope.set(progressKey(scanScope), { active: true, queued: true, started_at: new Date().toISOString(), stage: 'queued',
      stages: Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 'pending'])),
      scanned: 0, total_targets: 0, discovered: 0 });
    return res.status(202).json({ queued: true, queue: 'observe:scan:network', queue_job_id: payload.queue_job_id });
  }

  try {
    const onProgress = makeOnProgress(scanScope);
    const out = await runDiscovery({ db, redis, input: payload, onProgress });
    runsTotal.inc({ status: out.status === 'canary_abort' ? 'failed' : 'completed' });
    await logAudit(db, req, { resource_id: out.run_id, summary_suffix: out.summary ? ` | assets=${out.summary.discovered_assets} edges=${out.summary.topology_edges}` : '' });
    res.status(202).json({ ...out, queued: false });
  } finally {
    await releaseScanAdmission(redis, admission).catch(() => {});
  }
}));

app.get('/api/discovery/runs', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT * FROM observe_discovery_runs WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 ORDER BY started_at DESC LIMIT 100`,
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ runs: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/assets', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT * FROM observe_assets WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 ORDER BY updated_at DESC LIMIT 500`,
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ assets: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/findings', requireAuthOpt, asyncRoute(async (req, res) => {
  const runId = req.query.run_id;
  const scope = requestScope(req, req.query);
  const sql = runId
    ? 'SELECT * FROM observe_discovery_findings WHERE run_id = $1 AND tenant_id = $2 AND site_id = $3 AND edge_id = $4 ORDER BY observed_at DESC LIMIT 500'
    : 'SELECT * FROM observe_discovery_findings WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 ORDER BY observed_at DESC LIMIT 500';
  const vals = runId ? [runId, scope.tenant_id, scope.site_id, scope.edge_id] : [scope.tenant_id, scope.site_id, scope.edge_id];
  const r = await db.query(sql, vals);
  res.json({ findings: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/topology', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    'SELECT * FROM observe_topology_edges WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 ORDER BY observed_at DESC LIMIT 500',
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ edges: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/fingerprints', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    'SELECT * FROM observe_service_fingerprints WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 ORDER BY observed_at DESC LIMIT 500',
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ fingerprints: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/policies', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    'SELECT * FROM observe_discovery_policies WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 ORDER BY updated_at DESC LIMIT 100',
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ policies: r.rows, total: r.rowCount });
}));

app.post('/api/discovery/policies', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.name || typeof b.name !== 'string') return res.status(400).json({ error: 'name é obrigatório' });
  if (b.scan_profile && !['safe', 'balanced', 'aggressive'].includes(b.scan_profile)) {
    return res.status(400).json({ error: 'scan_profile inválido' });
  }
  const scope = requestScope(req, b);
  const r = await db.query(
    `INSERT INTO observe_discovery_policies
      (id, tenant_id, site_id, edge_id, name, scan_profile, active_enabled, passive_enabled, allowed_ranges, blocked_ranges,
       max_rate_per_minute, auto_prometheus_sd, auto_icinga_sync, is_default, metadata)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      scope.tenant_id, scope.site_id, scope.edge_id, b.name || 'policy', b.scan_profile || 'safe',
      b.active_enabled !== false, b.passive_enabled !== false, JSON.stringify(b.allowed_ranges || []), JSON.stringify(b.blocked_ranges || []),
      b.max_rate_per_minute || 300, b.auto_prometheus_sd !== false, b.auto_icinga_sync === true, b.is_default === true,
      JSON.stringify(b.metadata || {}),
    ]
  );
  await logAudit(db, req, { resource_id: r.rows[0].id });
  res.status(201).json({ policy: r.rows[0] });
}));

app.patch('/api/discovery/policies/:id', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  if (b.scan_profile && !['safe', 'balanced', 'aggressive'].includes(b.scan_profile)) {
    return res.status(400).json({ error: 'scan_profile inválido' });
  }
  const sets = [];
  const vals = [];
  let i = 1;
  const maybe = (col, val) => { if (val !== undefined) { sets.push(`${col} = $${i++}`); vals.push(val); } };
  maybe('name', b.name);
  maybe('scan_profile', b.scan_profile);
  maybe('active_enabled', b.active_enabled);
  maybe('passive_enabled', b.passive_enabled);
  maybe('allowed_ranges', b.allowed_ranges != null ? JSON.stringify(b.allowed_ranges) : undefined);
  maybe('blocked_ranges', b.blocked_ranges != null ? JSON.stringify(b.blocked_ranges) : undefined);
  maybe('max_rate_per_minute', b.max_rate_per_minute);
  maybe('host_timeout_ms', b.host_timeout_ms);
  maybe('max_concurrency', b.max_concurrency);
  maybe('allow_udp', b.allow_udp);
  maybe('auto_prometheus_sd', b.auto_prometheus_sd);
  maybe('auto_icinga_sync', b.auto_icinga_sync);
  maybe('is_default', b.is_default);
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  const scope = requestScope(req, b);
  sets.push(`updated_at = NOW()`);
  vals.push(id, scope.tenant_id, scope.site_id, scope.edge_id);
  const r = await db.query(
    `UPDATE observe_discovery_policies SET ${sets.join(', ')}
     WHERE id = $${i} AND tenant_id = $${i + 1} AND site_id = $${i + 2} AND edge_id = $${i + 3}
     RETURNING *`,
    vals
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Política não encontrada' });
  await logAudit(db, req, { resource_id: id });
  res.json({ policy: r.rows[0] });
}));

app.delete('/api/discovery/policies/:id', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.body);
  const r = await db.query(
    `DELETE FROM observe_discovery_policies
     WHERE id = $1 AND tenant_id = $2 AND site_id = $3 AND edge_id = $4 RETURNING id, name`,
    [req.params.id, scope.tenant_id, scope.site_id, scope.edge_id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Política não encontrada' });
  await logAudit(db, req, { resource_id: req.params.id, resource_key: r.rows[0].name });
  res.json({ deleted: true, id: req.params.id, name: r.rows[0].name });
}));

// ── Targets CRUD ──────────────────────────────────────────────────────────────
app.get('/api/discovery/targets', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT t.*, p.name AS policy_name FROM observe_discovery_targets t
     LEFT JOIN observe_discovery_policies p ON t.policy_id = p.id
     WHERE t.tenant_id = $1 AND t.site_id = $2 AND t.edge_id = $3
     ORDER BY t.created_at DESC LIMIT 500`,
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ targets: r.rows, total: r.rowCount });
}));

app.post('/api/discovery/targets', requireAuth, requireWrite, requireQuota('targets'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.address) return res.status(400).json({ error: 'address é obrigatório' });
  const validTypes = ['ip', 'hostname', 'cidr', 'range'];
  if (b.discovery_type && !validTypes.includes(b.discovery_type)) {
    return res.status(400).json({ error: 'discovery_type inválido' });
  }
  const scope = requestScope(req, b);
  const r = await db.query(
    `INSERT INTO observe_discovery_targets
      (id, tenant_id, site_id, edge_id, policy_id, discovery_type, address, label, enabled, metadata)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, site_id, edge_id, discovery_type, address)
     DO UPDATE SET label = EXCLUDED.label, enabled = EXCLUDED.enabled, updated_at = NOW()
     RETURNING *`,
    [
      scope.tenant_id, scope.site_id, scope.edge_id,
      b.policy_id || null, b.discovery_type || 'ip', b.address,
      b.label || null, b.enabled !== false, JSON.stringify(b.metadata || {}),
    ]
  );
  await logAudit(db, req, { resource_id: r.rows[0].id });
  res.status(201).json({ target: r.rows[0] });
}));

app.patch('/api/discovery/targets/:id', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  const maybe = (col, val) => { if (val !== undefined) { sets.push(`${col} = $${i++}`); vals.push(val); } };
  maybe('address', b.address);
  maybe('label', b.label);
  maybe('enabled', b.enabled);
  maybe('policy_id', b.policy_id);
  maybe('discovery_type', b.discovery_type);
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  const scope = requestScope(req, b);
  sets.push(`updated_at = NOW()`);
  vals.push(id, scope.tenant_id, scope.site_id, scope.edge_id);
  const r = await db.query(
    `UPDATE observe_discovery_targets SET ${sets.join(', ')}
     WHERE id = $${i} AND tenant_id = $${i + 1} AND site_id = $${i + 2} AND edge_id = $${i + 3}
     RETURNING *`,
    vals
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Target não encontrado' });
  await logAudit(db, req, { resource_id: id });
  res.json({ target: r.rows[0] });
}));

app.delete('/api/discovery/targets/:id', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.body);
  const r = await db.query(
    `DELETE FROM observe_discovery_targets
     WHERE id = $1 AND tenant_id = $2 AND site_id = $3 AND edge_id = $4 RETURNING id, address`,
    [req.params.id, scope.tenant_id, scope.site_id, scope.edge_id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Target não encontrado' });
  await logAudit(db, req, { resource_id: req.params.id, resource_key: r.rows[0].address });
  res.json({ deleted: true, id: req.params.id, address: r.rows[0].address });
}));

// ── Assets — atualizar ciclo de vida ─────────────────────────────────────────
const VALID_LIFECYCLE = ['discovered', 'approved', 'monitored', 'ignored', 'quarantined', 'disappeared'];

app.patch('/api/discovery/assets/:id', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  if (b.lifecycle_state && !VALID_LIFECYCLE.includes(b.lifecycle_state)) {
    return res.status(400).json({ error: 'lifecycle_state inválido' });
  }
  const sets = [];
  const vals = [];
  let i = 1;
  const maybe = (col, val) => { if (val !== undefined) { sets.push(`${col} = $${i++}`); vals.push(val); } };
  maybe('lifecycle_state', b.lifecycle_state);
  maybe('criticality', b.criticality);
  maybe('display_name', b.display_name);
  if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  const scope = requestScope(req, b);
  sets.push(`updated_at = NOW()`);
  vals.push(id, scope.tenant_id, scope.site_id, scope.edge_id);
  const r = await db.query(
    `UPDATE observe_assets SET ${sets.join(', ')}
     WHERE id = $${i} AND tenant_id = $${i + 1} AND site_id = $${i + 2} AND edge_id = $${i + 3}
     RETURNING *`,
    vals
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Ativo não encontrado' });
  await logAudit(db, req, { resource_id: id });
  res.json({ asset: r.rows[0] });
}));

app.post('/api/discovery/passive/events', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [req.body];
  const accepted = await ingestPassiveEvents(events);
  await logAudit(db, req, { summary_suffix: `events=${accepted}` });
  res.status(202).json({ accepted });
}));

// ── Audit log (Enterprise) ────────────────────────────────────────────────────
app.get('/api/discovery/audit', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const limit = Math.min(Math.max(1, parseInt(req.query.limit || '50', 10)), 500);

  const conditions = [
    'tenant_id = $1',
    'site_id = $2',
    'edge_id = $3',
  ];
  const params = [scope.tenant_id, scope.site_id, scope.edge_id];

  if (req.query.action) {
    params.push(req.query.action);
    conditions.push(`action = $${params.length}`);
  }
  if (req.query.actor) {
    params.push(req.query.actor);
    conditions.push(`actor = $${params.length}`);
  }
  if (req.query.resource_type) {
    params.push(req.query.resource_type);
    conditions.push(`resource_type = $${params.length}`);
  }
  if (req.query.resource_id) {
    params.push(req.query.resource_id);
    conditions.push(`resource_id = $${params.length}`);
  }

  const where = conditions.join(' AND ');
  params.push(limit);

  const r = await db.query(
    `SELECT id, tenant_id, site_id, edge_id, actor, actor_role, actor_ip, action, resource_type, resource_id, resource_key, summary, created_at
     FROM observe_audit_log
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  // Count total (sem LIMIT, mesmos filtros)
  const countParams = params.slice(0, -1);
  const cr = await db.query(
    `SELECT COUNT(*)::int AS total FROM observe_audit_log WHERE ${where}`,
    countParams
  );

  res.json({ events: r.rows, total: cr.rows[0]?.total || 0 });
}));

app.get('/api/discovery/history', requireAuthOpt, asyncRoute(async (req, res) => {
  const assetId = req.query.asset_id;
  if (!assetId) return res.status(400).json({ error: 'asset_id is required' });
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT * FROM observe_asset_changes WHERE asset_id = $1 AND tenant_id = $2 AND site_id = $3 AND edge_id = $4 ORDER BY changed_at DESC LIMIT 500`,
    [assetId, scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ changes: r.rows, total: r.rowCount });
}));

// ── Services per asset (Enterprise) ─────────────────────────────────────
app.get('/api/discovery/assets/:id/services', requireAuth, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT s.id, s.service_key, s.service_name, s.protocol, s.port, s.status, s.fingerprint,
            s.first_seen_at, s.last_seen_at
     FROM observe_asset_services s
     WHERE s.asset_id = $1 AND s.tenant_id = $2 AND s.site_id = $3 AND s.edge_id = $4
     ORDER BY s.port`,
    [id, scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ services: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/prometheus/http-sd', asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT a.tenant_id, a.site_id, a.edge_id, a.asset_name, a.primary_ip, s.port, s.protocol
     FROM observe_assets a
     JOIN observe_asset_services s ON s.asset_id = a.id
     WHERE s.status = 'open'
       AND a.lifecycle_state IN ('approved', 'monitored')
       AND a.tenant_id = $1 AND a.site_id = $2 AND a.edge_id = $3
       AND s.port IN (9100,9104,9108,9115,9117,9121,9187,9256,9419,9090,9091)
     ORDER BY a.updated_at DESC LIMIT 1000`
    , [scope.tenant_id, scope.site_id, scope.edge_id]
  );

  const assets = new Map();
  for (const row of r.rows) {
    const key = `${row.tenant_id}:${row.site_id}:${row.edge_id}:${row.asset_name}`;
    if (!assets.has(key)) {
      assets.set(key, {
        tenant_id: row.tenant_id,
        site_id: row.site_id,
        edge_id: row.edge_id,
        asset_name: row.asset_name,
        services: [],
      });
    }
    assets.get(key).services.push({
      exporter_target: `${row.primary_ip}:${row.port}`,
      job: row.port === 9100 ? 'node-exporter' : 'discovered-exporter',
    });
  }

  res.json(toPromSdGroups([...assets.values()]));
}));

app.get('/api/discovery/graph/shortest-path', requireAuth, asyncRoute(async (req, res) => {
  if (!neo4jEnabled()) return res.status(503).json({ error: 'neo4j_not_enabled' });
  const scope = requestScope(req, req.query);
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  if (!from || !to) return res.status(400).json({ error: 'from e to são obrigatórios' });
  const out = await shortestPath({
    tenant: scope,
    fromAssetKey: from,
    toAssetRef: to,
    maxDepth: parseInt(req.query.max_depth || '8', 10),
  });
  res.json(out);
}));

app.get('/api/discovery/graph/blast-radius', requireAuth, asyncRoute(async (req, res) => {
  if (!neo4jEnabled()) return res.status(503).json({ error: 'neo4j_not_enabled' });
  const scope = requestScope(req, req.query);
  const asset = String(req.query.asset_key || '').trim();
  if (!asset) return res.status(400).json({ error: 'asset_key é obrigatório' });
  const out = await blastRadius({
    tenant: scope,
    assetKey: asset,
    depth: parseInt(req.query.depth || '2', 10),
    limit: parseInt(req.query.limit || '200', 10),
  });
  res.json(out);
}));

app.get('/observe/discovery', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(DISCOVERY_UI_HTML);
});

app.get('/observe/discovery/data/summary', requireAuthOpt, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const [runs, assets, findings, fps, edges, policies, targets, services] = await Promise.all([
    db.query('SELECT id, status, started_at, completed_at, summary FROM observe_discovery_runs WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY started_at DESC LIMIT 50', [scope.tenant_id, scope.site_id, scope.edge_id]),
    db.query('SELECT id, asset_name, display_name, primary_ip, vendor, product, lifecycle_state, criticality, confidence, updated_at FROM observe_assets WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY updated_at DESC LIMIT 500', [scope.tenant_id, scope.site_id, scope.edge_id]),
    db.query('SELECT id, finding_type, severity, source, observed_at FROM observe_discovery_findings WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY observed_at DESC LIMIT 200', [scope.tenant_id, scope.site_id, scope.edge_id]),
    db.query('SELECT id, service_key, confidence, observed_at FROM observe_service_fingerprints WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY observed_at DESC LIMIT 200', [scope.tenant_id, scope.site_id, scope.edge_id]),
    db.query('SELECT id, edge_type, from_asset_id, to_asset_ref, observed_at FROM observe_topology_edges WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY observed_at DESC LIMIT 200', [scope.tenant_id, scope.site_id, scope.edge_id]),
    db.query('SELECT * FROM observe_discovery_policies WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY is_default DESC, updated_at DESC', [scope.tenant_id, scope.site_id, scope.edge_id]),
    db.query('SELECT t.*, p.name AS policy_name FROM observe_discovery_targets t LEFT JOIN observe_discovery_policies p ON t.policy_id = p.id WHERE t.tenant_id=$1 AND t.site_id=$2 AND t.edge_id=$3 ORDER BY t.created_at DESC LIMIT 500', [scope.tenant_id, scope.site_id, scope.edge_id]),
    db.query('SELECT s.id, s.asset_id, s.service_key, s.service_name, s.protocol, s.port, s.status, s.fingerprint, a.asset_name, a.primary_ip FROM observe_asset_services s JOIN observe_assets a ON s.asset_id = a.id WHERE s.tenant_id=$1 AND s.site_id=$2 AND s.edge_id=$3 ORDER BY a.asset_name, s.port LIMIT 500', [scope.tenant_id, scope.site_id, scope.edge_id]),
  ]);
  res.json({
    scope,
    runs: runs.rows,
    assets: assets.rows,
    findings: findings.rows,
    fingerprints: fps.rows,
    topology: edges.rows,
    policies: policies.rows,
    targets: targets.rows,
    services: services.rows,
  });
}));

app.get('/observe/discovery/data/scopes', requireAuthOpt, asyncRoute(async (_req, res) => {
  const list = async (column) => {
    const r = await db.query(
      `WITH scoped AS (
         SELECT ${column} AS value FROM observe_discovery_runs
         UNION SELECT ${column} AS value FROM observe_assets
         UNION SELECT ${column} AS value FROM observe_discovery_findings
         UNION SELECT ${column} AS value FROM observe_topology_edges
         UNION SELECT ${column} AS value FROM observe_service_fingerprints
         UNION SELECT ${column} AS value FROM observe_discovery_policies
         UNION SELECT ${column} AS value FROM observe_discovery_targets
       )
       SELECT DISTINCT value FROM scoped WHERE value IS NOT NULL AND value <> '' ORDER BY value`
    );
    return r.rows.map(row => row.value);
  };

  const [tenants, sites, edges] = await Promise.all([list('tenant_id'), list('site_id'), list('edge_id')]);
  res.json({ tenants, sites, edges });
}));

// ── SNMP Deep Discovery ─────────────────────────────────────────────────

const { snmpDeepDiscover } = require('./scanners/snmp-deep');
const { collectMetrics: collectSnmpMetrics } = require('./scanners/snmp-metrics');
const { discoverRoutingProtocols } = require('./scanners/topology-protocols');

app.post('/api/discovery/snmp/deep/:host', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const { host } = req.params;
  if (!isValidHost(host)) return res.status(400).json({ error: 'host inválido' });
  const community = req.body?.community || req.query?.community || 'public';
  const result = await snmpDeepDiscover(host, { community });

  // Persiste resultado
  const scope = requestScope(req, req.body);
  await db.query(
    `INSERT INTO observe_snmp_results
     (tenant_id, site_id, edge_id, asset_id, host, sys_descr, sys_object_id, sys_name, sys_uptime,
      sys_contact, sys_location, sys_services, classification, interfaces, interface_count,
      vlans, arp_table, entity, serial_number, model, cpu, memory, storage, wireless,
      ospf, bgp, vrrp, reachable, auth_failure, errors, collected_at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
     ON CONFLICT (tenant_id, site_id, edge_id, host)
     DO UPDATE SET
       sys_descr=EXCLUDED.sys_descr, sys_object_id=EXCLUDED.sys_object_id,
       sys_name=EXCLUDED.sys_name, classification=EXCLUDED.classification,
       interfaces=EXCLUDED.interfaces, interface_count=EXCLUDED.interface_count,
       vlans=EXCLUDED.vlans, arp_table=EXCLUDED.arp_table, entity=EXCLUDED.entity,
       serial_number=EXCLUDED.serial_number, model=EXCLUDED.model,
       cpu=EXCLUDED.cpu, memory=EXCLUDED.memory, storage=EXCLUDED.storage,
       wireless=EXCLUDED.wireless, ospf=EXCLUDED.ospf, bgp=EXCLUDED.bgp,
       vrrp=EXCLUDED.vrrp, reachable=EXCLUDED.reachable,
       auth_failure=EXCLUDED.auth_failure, errors=EXCLUDED.errors,
       collected_at=NOW()`,
    [scope.tenant_id, scope.site_id, scope.edge_id, host,
     result.sysDescr, result.sysObjectID, result.sysName, result.sysUptime,
     result.sysContact, result.sysLocation, result.sysServices,
     JSON.stringify(result.classification), JSON.stringify(result.interfaces),
     result.interface_count, JSON.stringify(result.vlans), JSON.stringify(result.arp_table),
     JSON.stringify(result.entity), result.serial, result.model,
     JSON.stringify(result.cpu), JSON.stringify(result.memory), JSON.stringify(result.storage),
     JSON.stringify(result.wireless), null, null, null,
     result.reachable, result.auth_failure, JSON.stringify(result.errors)]
  );

  const alertRulesResult = await db.query(
    `SELECT * FROM observe_alert_rules WHERE tenant_id=$1 AND site_id=$2 AND enabled=true ORDER BY name`,
    [scope.tenant_id, scope.site_id]
  );
  const alertRules = alertRulesResult.rows.length ? alertRulesResult.rows.map((rule) => ({
    ...rule,
    conditions: typeof rule.conditions === 'string' ? JSON.parse(rule.conditions) : rule.conditions,
    transports: typeof rule.transports === 'string' ? JSON.parse(rule.transports) : rule.transports,
  })) : BUILTIN_RULES;
  const alerts = await evaluateAlerts(alertRules, {
    host,
    snmp_up: result.reachable ? 1 : 0,
    asset_id: null,
  }, scope, db);

  await logAudit(db, req, { resource_id: host });
  res.json({ ...result, alerts_fired: alerts.length });
}));

app.get('/api/discovery/snmp/results', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const host = req.query.host;
  let query = 'SELECT * FROM observe_snmp_results WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3';
  const params = [scope.tenant_id, scope.site_id, scope.edge_id];
  if (host) { query += ' AND host=$4'; params.push(host); }
  query += ' ORDER BY collected_at DESC LIMIT 500';
  const r = await db.query(query, params);
  res.json({ results: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/snmp/results/:host', requireAuth, asyncRoute(async (req, res) => {
  const { host } = req.params;
  const scope = requestScope(req, req.query);
  const r = await db.query(
    'SELECT * FROM observe_snmp_results WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 AND host=$4',
    [scope.tenant_id, scope.site_id, scope.edge_id, host]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
}));

// ── SNMP Metrics ────────────────────────────────────────────────────────────

app.get('/api/discovery/snmp/metrics/:host', requireAuth, asyncRoute(async (req, res) => {
  const { host } = req.params;
  if (!isValidHost(host)) return res.status(400).json({ error: 'host inválido' });
  const community = req.query.community || 'public';
  const format = req.query.format || 'json';

  const metrics = await collectSnmpMetrics(host, { community });

  if (format === 'prometheus') {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.send(metrics);
  }

  // JSON simplificado
  const lines = metrics.split('\n').filter(l => l && !l.startsWith('#'));
  const parsed = {};
  for (const line of lines) {
    const m = line.match(/^(\w+)\{(.+)\}\s+(.+)$/);
    if (m) {
      const labels = Object.fromEntries(m[2].split(',').map(p => p.split('=').map(s => s.replace(/"/g, ''))));
      const key = `${m[1]}:${labels.if_name || labels.mountpoint || labels.mode || ''}`;
      parsed[key] = { name: m[1], value: parseFloat(m[3]), labels };
    }
  }
  res.json({ host, metrics: parsed });
}));

// ── Routing Protocols ───────────────────────────────────────────────────────

app.get('/api/discovery/snmp/routing/:host', requireAuth, asyncRoute(async (req, res) => {
  const { host } = req.params;
  if (!isValidHost(host)) return res.status(400).json({ error: 'host inválido' });
  const community = req.query.community || 'public';
  const result = await discoverRoutingProtocols(host, { community });

  // Persiste
  const scope = requestScope(req, req.query);
  await db.query(
    `INSERT INTO observe_snmp_results
     (tenant_id, site_id, edge_id, host, ospf, bgp, vrrp, collected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (tenant_id, site_id, edge_id, host)
     DO UPDATE SET ospf=EXCLUDED.ospf, bgp=EXCLUDED.bgp, vrrp=EXCLUDED.vrrp, collected_at=NOW()`,
    [scope.tenant_id, scope.site_id, scope.edge_id, host,
     JSON.stringify(result.ospf), JSON.stringify(result.bgp), JSON.stringify(result.vrrp)]
  );

  res.json(result);
}));

// ── IPAM ────────────────────────────────────────────────────────────────────

const { IpamRepository, parseSubnet, listSubnetIps, splitSubnet } = require('./engine/ipam');

const ipamRepo = new IpamRepository(db);

app.get('/api/discovery/ipam/subnets', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const subnets = await ipamRepo.getSubnets({ tenant_id: scope.tenant_id, site_id: scope.site_id });
  res.json({ subnets, total: subnets.length });
}));

app.post('/api/discovery/ipam/subnets', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const { cidr, name, description, parent_id, vlan_id, gateway } = req.body || {};
  if (!cidr) return res.status(400).json({ error: 'cidr é obrigatório' });
  const scope = requestScope(req, req.body);
  const subnet = await ipamRepo.createSubnet({
    cidr, name, description, parent_id,
    site_id: scope.site_id, tenant_id: scope.tenant_id, vlan_id, gateway,
  });
  await logAudit(db, req, { resource_id: subnet.id });
  res.status(201).json({ subnet });
}));

app.get('/api/discovery/ipam/subnets/:cidr/ips', requireAuth, asyncRoute(async (req, res) => {
  const { cidr } = req.params;
  const scope = requestScope(req, req.query);
  const ips = await ipamRepo.getIpsInSubnet(cidr, scope.tenant_id, scope.site_id);
  const utilization = await ipamRepo.getSubnetUtilization(cidr, scope.tenant_id, scope.site_id);
  res.json({ cidr, ips, utilization });
}));

app.get('/api/discovery/ipam/subnets/:cidr/info', requireAuth, asyncRoute(async (req, res) => {
  const { cidr } = req.params;
  const info = parseSubnet(cidr);
  res.json(info);
}));

app.get('/api/discovery/ipam/find/:ip', requireAuth, asyncRoute(async (req, res) => {
  const { ip } = req.params;
  const scope = requestScope(req, req.query);
  const subnet = await ipamRepo.findSubnetForIp(ip, scope.tenant_id, scope.site_id);
  res.json({ ip, subnet: subnet || null });
}));

// ── Alerting ────────────────────────────────────────────────────────────────

const { evaluateAlerts, BUILTIN_RULES } = require('./engine/alerting');

app.get('/api/discovery/alerts', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
  const severity = req.query.severity;
  let query = 'SELECT * FROM observe_alerts WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3';
  const params = [scope.tenant_id, scope.site_id, scope.edge_id];
  if (severity) { query += ' AND severity=$4'; params.push(severity); }
  query += ' ORDER BY fired_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);
  const r = await db.query(query, params);
  res.json({ alerts: r.rows, total: r.rowCount });
}));

app.get('/api/discovery/alerts/active', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    'SELECT * FROM observe_alerts WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 AND resolved_at IS NULL ORDER BY fired_at DESC LIMIT 500',
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ alerts: r.rows, total: r.rowCount });
}));

app.post('/api/discovery/alerts/:id/acknowledge', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const { id } = req.params;
  const scope = requestScope(req, req.body);
  const r = await db.query(
    `UPDATE observe_alerts SET acknowledged=true, acknowledged_by=$2, acknowledged_at=NOW()
     WHERE id=$1 AND tenant_id=$3 AND site_id=$4 AND edge_id=$5 AND acknowledged=false RETURNING *`,
    [id, req.auth?.sub || 'unknown', scope.tenant_id, scope.site_id, scope.edge_id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not_found_or_already_acked' });
  await logAudit(db, req, { resource_id: id });
  res.json({ alert: r.rows[0] });
}));

app.get('/api/discovery/alerts/rules', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    'SELECT * FROM observe_alert_rules WHERE tenant_id=$1 AND site_id=$2 ORDER BY name',
    [scope.tenant_id, scope.site_id]
  );
  const all = r.rows.length > 0 ? r.rows : BUILTIN_RULES.map((rule, i) => ({
    ...rule, id: `builtin-${i}`, conditions: JSON.stringify(rule.conditions),
    transports: JSON.stringify(rule.transports), enabled: true,
  }));
  res.json({ rules: all, total: all.length });
}));

// ── Config Backup ───────────────────────────────────────────────────────────

const { backupConfig } = require('./engine/config-backup');

app.post('/api/discovery/config-backup/:host', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const { host } = req.params;
  if (!isValidHost(host)) return res.status(400).json({ error: 'host inválido' });
  if (req.body?.ssh_port != null && !isValidPort(req.body.ssh_port)) return res.status(400).json({ error: 'ssh_port inválida' });
  const asset = {
    host,
    ...requestScope(req, req.body),
    ssh_user: req.body?.ssh_user,
    ssh_password: req.body?.ssh_password,
    ssh_port: req.body?.ssh_port,
    vendor: req.body?.vendor,
  };
  const result = await backupConfig(asset, db);
  await logAudit(db, req, { resource_id: host });
  res.json(result);
}));

app.get('/api/discovery/config-backup', requireAuth, asyncRoute(async (req, res) => {
  const host = req.query.host;
  const scope = requestScope(req, req.query);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  let query = 'SELECT id, host, vendor, method, success, sha256, lines, error, collected_at FROM observe_config_backups WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3';
  const params = [scope.tenant_id, scope.site_id, scope.edge_id];
  if (host) { query += ' AND host=$4'; params.push(host); }
  query += ' ORDER BY collected_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);
  const r = await db.query(query, params);
  res.json({ backups: r.rows, total: r.rowCount });
}));

// ── Schedules e quotas ────────────────────────────────────────────────────
app.get('/api/discovery/schedules', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT * FROM observe_discovery_schedules WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY name`,
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ schedules: r.rows, total: r.rowCount });
}));

app.post('/api/discovery/schedules', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.body);
  const { name, cron_expression, policy_id, profile_override, enabled = true } = req.body || {};
  if (!name || !cron_expression) return res.status(400).json({ error: 'name e cron_expression são obrigatórios' });
  const next = calcNextRun(cron_expression, new Date());
  if (!next) return res.status(400).json({ error: 'cron_expression inválida ou sem execução nos próximos 366 dias' });
  if (profile_override && !['safe', 'balanced', 'aggressive'].includes(profile_override)) return res.status(400).json({ error: 'profile_override inválido' });
  const r = await db.query(
    `INSERT INTO observe_discovery_schedules
      (tenant_id,site_id,edge_id,policy_id,name,cron_expression,profile_override,enabled,next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [scope.tenant_id, scope.site_id, scope.edge_id, policy_id || null, String(name).slice(0, 200), cron_expression, profile_override || null, enabled !== false, next]
  );
  await logAudit(db, req, { resource_id: r.rows[0].id });
  res.status(201).json({ schedule: r.rows[0] });
}));

app.patch('/api/discovery/schedules/:id', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.body);
  const allowed = ['name', 'cron_expression', 'profile_override', 'enabled'];
  const sets = []; const params = [req.params.id, scope.tenant_id, scope.site_id, scope.edge_id];
  for (const field of allowed) {
    if (req.body?.[field] === undefined) continue;
    if (field === 'cron_expression' && !calcNextRun(req.body[field], new Date())) return res.status(400).json({ error: 'cron_expression inválida' });
    if (field === 'profile_override' && req.body[field] && !['safe', 'balanced', 'aggressive'].includes(req.body[field])) return res.status(400).json({ error: 'profile_override inválido' });
    params.push(req.body[field]); sets.push(`${field}=$${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'nenhum campo atualizável' });
  if (req.body.cron_expression) { params.push(calcNextRun(req.body.cron_expression, new Date())); sets.push(`next_run_at=$${params.length}`); }
  const r = await db.query(
    `UPDATE observe_discovery_schedules SET ${sets.join(',')},updated_at=NOW()
     WHERE id=$1 AND tenant_id=$2 AND site_id=$3 AND edge_id=$4 RETURNING *`, params
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  await logAudit(db, req, { resource_id: req.params.id });
  res.json({ schedule: r.rows[0] });
}));

app.delete('/api/discovery/schedules/:id', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `DELETE FROM observe_discovery_schedules WHERE id=$1 AND tenant_id=$2 AND site_id=$3 AND edge_id=$4 RETURNING id`,
    [req.params.id, scope.tenant_id, scope.site_id, scope.edge_id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  await logAudit(db, req, { resource_id: req.params.id });
  res.json({ deleted: true, id: req.params.id });
}));

app.get('/api/discovery/quotas', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const { getQuota } = require('./quotas');
  res.json({ quota: await getQuota(db, scope.tenant_id) });
}));

// ── Remote agents ─────────────────────────────────────────────────────────
app.get('/api/discovery/agents', requireAuth, asyncRoute(async (req, res) => {
  const scope = requestScope(req, req.query);
  const r = await db.query(
    `SELECT agent_id,hostname,subnets,capabilities,version,status,last_seen_at,created_at,updated_at
     FROM observe_discovery_agents WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 ORDER BY agent_id`,
    [scope.tenant_id, scope.site_id, scope.edge_id]
  );
  res.json({ agents: r.rows, total: r.rowCount });
}));

app.post('/api/discovery/agents/register', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  if (!validAgentId(req.body?.agent_id) || !req.body?.hostname) return res.status(400).json({ error: 'agent_id ou hostname inválido' });
  const scope = requestScope(req, req.body);
  res.status(201).json(await handleAgentRegister(db, req.body, scope));
}));

app.post('/api/discovery/agents/heartbeat', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  if (!validAgentId(req.body?.agent_id)) return res.status(400).json({ error: 'agent_id inválido' });
  const scope = requestScope(req, req.body);
  const result = await handleAgentHeartbeat(db, req.body, scope);
  res.json(result);
}));

app.post('/api/discovery/agents/report', requireAuth, requireWrite, asyncRoute(async (req, res) => {
  if (!validAgentId(req.body?.agent_id)) return res.status(400).json({ error: 'agent_id inválido' });
  if (!Array.isArray(req.body?.assets) || !Array.isArray(req.body?.findings) || req.body.assets.length > 1000 || req.body.findings.length > 5000) {
    return res.status(400).json({ error: 'report inválido ou acima do limite' });
  }
  const scope = requestScope(req, req.body);
  res.json(await handleAgentReport({ db, redis, body: { ...req.body, scope } }));
}));

// ── 404 ─────────────────────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.use(createHttpErrorHandler({ log, service: 'r-observe-discovery' }));

if (process.env.NODE_ENV === 'development') {
  import('vite').then(({ createServer: createVite }) =>
    createVite({
      root: path.join(__dirname, '..'),
      configFile: path.join(__dirname, '../vite.config.js'),
      server: { middlewareMode: true },
      appType: 'custom',
    }).then((v) => { _vite = v; log('info', 'Vite dev server ativo (HMR em /src/ui/main.js)'); })
  ).catch((e) => log('warn', 'Vite init falhou', { err: e.message }));
}

let stopPassiveReceivers = null;
if (PASSIVE_LISTENERS_ENABLED) {
  try {
    stopPassiveReceivers = startPassiveReceivers({
      onEvent: (evt) => {
        ingestPassiveEvents([evt]).catch((e) => {
          log('warn', 'Passive listener event ingestion failed', { err: e.message });
        });
      },
    });
  } catch (e) {
    log('warn', 'Passive listeners startup failed', { err: e.message });
  }
}

// ── Auto-attach em todas as redes Docker ────────────────────────────────
// Conecta este container a todas as redes bridge/overlay disponíveis
// para que ARP e TCP scan alcancem containers em qualquer rede.
// Não requer configuração manual de networks no docker-compose.
autoAttachAllNetworks().catch(e => log('warn', 'Docker auto-attach failed', { err: e.message }));

const lifecycle = createLifecycle({ label: 'r-observe-discovery', log });
lifecycle.addCloser('db', () => db.end());
if (redis) lifecycle.addCloser('redis', () => redis.quit());
if (queueRedis) {
  lifecycle.addCloser('reliableQueueConsumer', () => reliableQueueConsumer.stop());
  lifecycle.addCloser('queueRedis', () => queueRedis.quit());
}
lifecycle.addCloser('neo4j', () => closeNeo4jDriver());
lifecycle.addCloser('passiveReceivers', () => { try { if (typeof stopPassiveReceivers === 'function') stopPassiveReceivers(); } catch (_) {} });
const stopScheduler = startScheduler({ db, redis });
lifecycle.addCloser('scheduler', stopScheduler);
const stopRetention = startRetention({ db });
lifecycle.addCloser('retention', stopRetention);
const stopRunRecovery = startRunRecovery({ db });
lifecycle.addCloser('runRecovery', stopRunRecovery);

const server = app.listen(PORT, '0.0.0.0', () => log('info', `Discovery API on :${PORT}`));
lifecycle.onServer(server);

// ── Agent offline detection ─────────────────────────────────────────────
const AGENT_OFFLINE_CHECK_ENABLED = process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false';
if (AGENT_OFFLINE_CHECK_ENABLED && db) {
  const { startOfflineDetection, stopOfflineDetection } = require('./scanners/agents');
  startOfflineDetection(db, redis);
  lifecycle.addCloser('agentOfflineDetection', () => { try { stopOfflineDetection(); } catch (_) {} });
}
lifecycle.start();

async function startScanQueueConsumer() {
  if (!queueRedis || !reliableQueueConsumer || !SCAN_QUEUE_ENABLED) return;
  const recovered = await reliableQueueConsumer.start();
  log('info', 'Scan queue consumer enabled', { queue: 'observe:scan:network' });
  if (recovered) log('warn', 'Recovered orphaned scan jobs', { recovered });
  while (!reliableQueueConsumer.isStopped()) {
    let raw = null;
    let task = null;
    try {
      raw = await reliableQueueConsumer.claim(1);
      if (!raw) continue;
      try {
        task = parseQueueJob(raw);
      } catch (parseError) {
        await reliableQueueConsumer.reject(raw, null, parseError);
        log('warn', 'Invalid scan queue payload moved to dead letter', { err: parseError.message });
        continue;
      }
      if (await reliableQueueConsumer.alreadyCompleted(task)) {
        await reliableQueueConsumer.acknowledge(raw, null);
        await releaseScanAdmission(redis, admissionFromJob(task)).catch(() => {});
        continue;
      }
      const scope = parseScope(task);
      const targets = Array.isArray(task.targets) ? task.targets : undefined;
      try {
        await runWithTenant(scope.tenant_id, async () => {
          const out = await runDiscovery({
            db,
            redis,
            input: {
              ...scope,
              policy_id: task.policy_id || null,
              profile: task.profile || 'safe',
              trigger: task.trigger || 'queue:observe:scan:network',
              queue_job_id: task.queue_job_id,
              subnet: task.subnet || null,
              targets,
              docker_discovery_enabled: DOCKER_DISCOVERY_ENABLED,
            },
            onProgress: makeOnProgress(scope),
          });
          if (task.schedule_id) {
            await db.query(
              `UPDATE observe_discovery_schedules SET last_run_status=$5, updated_at=NOW()
               WHERE id=$1 AND tenant_id=$2 AND site_id=$3 AND edge_id=$4`,
              [task.schedule_id, scope.tenant_id, scope.site_id, scope.edge_id,
                out.status === 'canary_abort' ? 'failed' : 'completed']
            );
          }
        });
        await reliableQueueConsumer.acknowledge(raw, task);
        await releaseScanAdmission(redis, admissionFromJob(task)).catch(() => {});
      } catch (scanError) {
        if (task.schedule_id) {
          await runWithTenant(scope.tenant_id, () => db.query(
            `UPDATE observe_discovery_schedules SET last_run_status='failed', updated_at=NOW()
             WHERE id=$1 AND tenant_id=$2 AND site_id=$3 AND edge_id=$4`,
            [task.schedule_id, scope.tenant_id, scope.site_id, scope.edge_id]
          )).catch(() => {});
        }
        const rejected = await reliableQueueConsumer.reject(raw, task, scanError);
        if (!rejected.retry) await releaseScanAdmission(redis, admissionFromJob(task)).catch(() => {});
        raw = null;
        log('warn', rejected.retry ? 'Scan job scheduled for retry' : 'Scan job moved to dead letter', {
          queue_job_id: task.queue_job_id, attempt: rejected.attempt, err: scanError.message,
        });
      }
    } catch (e) {
      log('warn', 'Scan queue consumer error', { err: e.message });
    }
  }
}

startScanQueueConsumer().catch((e) => log('warn', 'Scan queue startup error', { err: e.message }));

module.exports = app;

const IS_DEV = process.env.NODE_ENV === 'development';
const DEV_SCRIPT = IS_DEV
  ? '<script type="module" src="/src/ui/main.js"></script>'
  : '';

const DISCOVERY_UI_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Results · R-Observe Discovery</title>
  ${IS_DEV ? DEV_SCRIPT : '<link rel="stylesheet" href="/observe/discovery/data/discovery.css">'}
  <script src="/observe/discovery/data/vendor/react.min.js"></script>
  <script src="/observe/discovery/data/vendor/react-dom.min.js"></script>
  <script src="/observe/discovery/data/vendor/d3.min.js"></script>
</head>
<body>
  <div class="topbar">
    <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" width="28" height="28" style="flex-shrink:0"><rect width="28" height="28" rx="6" fill="#CC1212"/><text x="14" y="20" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="16" fill="white" text-anchor="middle">R</text></svg>
    <span class="topbar-brand">Results · Sistemas de Informática</span>
    <span class="topbar-title">/ R-Observe Discovery</span>
    <a href="/observe/home" style="margin-left:auto;color:#8b949e;font-size:.8rem;text-decoration:none;padding:.25rem .6rem;border:1px solid #30363d;border-radius:6px">⌂ Home</a>
  </div>
  <div id="app"></div>
  <script>
  const e = React.createElement;
  const API = '/observe/discovery/api/discovery';

  // ── Auth + Feedback ──────────────────────────────────────────────────────────
  let _feedbackSet = null;
  function showFeedback(msg) { if (_feedbackSet) _feedbackSet(msg); }

  function authHeaders() {
    return {};
  }

  // ── Traduções ────────────────────────────────────────────────────────────────
  const ESTADO = { discovered:'Descoberto', approved:'Aprovado', monitored:'Monitorado', ignored:'Ignorado', quarantined:'Quarentenado', disappeared:'Desaparecido' };
  const RUN_STATUS = { completed:'Concluído', running:'Em execução', failed:'Falhou', queued:'Na fila' };
  const SEVERITY = { warning:'Aviso', critical:'Crítico', info:'Informação', error:'Erro' };
  const FINDING_TYPE = { prometheus_sd_write_error:'Erro Prometheus SD', target_blocked:'Alvo bloqueado', docker_container_discovered:'Container Docker', asset_changed:'Ativo alterado', passive_signal:'Sinal passivo', new_asset:'Novo ativo' };
  const LIFECYCLE_OPTS = ['discovered','approved','monitored','ignored','quarantined','disappeared'];
  const CRITICALITY_OPTS = ['low','medium','high','critical'];
  const PROFILE_OPTS = ['safe','balanced','aggressive'];
  const TYPE_OPTS = ['ip','hostname','cidr','range'];

  function tr(map, val) { const v = String(val||'-').toLowerCase(); return map[v] || val || '-'; }
  function badge(cls, text) { return e('span', { className: 'badge badge-' + String(cls||'').toLowerCase() }, text); }
  function estadoBadge(v)  { return badge(v, tr(ESTADO, v)); }
  function runBadge(v)     { return badge(v, tr(RUN_STATUS, v)); }
  function sevBadge(v)     { return badge(v, tr(SEVERITY, v)); }
  function fmtDt(s)        { return s ? new Date(s).toLocaleString('pt-BR', {dateStyle:'short',timeStyle:'short'}) : '—'; }
  function fmtPct(v)       { const n=parseFloat(v); return isNaN(n) ? '—' : (n*100).toFixed(0)+'%'; }

  // ── Feedback (toast inline) ──────────────────────────────────────────────────
  function Feedback({ msg }) {
    if (!msg) return null;
    const ok = msg.startsWith('✓');
    return e('div', { className: 'scan-feedback ' + (ok ? 'ok' : 'err'), style:{margin:'6px 0'} }, msg);
  }

  // ── Input helpers ────────────────────────────────────────────────────────────
  function Input({ label, value, onChange, type='text', placeholder='', required, style }) {
    return e('label', { style:{ display:'flex', flexDirection:'column', gap:3, fontSize:'.8rem', color:'#8b949e', ...style } },
      label,
      e('input', {
        type, value, onChange: ev => onChange(ev.target.value),
        placeholder, required,
        style:{ background:'#0d1117', border:'1px solid #30363d', borderRadius:6, color:'#c9d1d9', padding:'5px 8px', fontSize:'.85rem' }
      })
    );
  }
  function Select({ label, value, onChange, options, style }) {
    return e('label', { style:{ display:'flex', flexDirection:'column', gap:3, fontSize:'.8rem', color:'#8b949e', ...style } },
      label,
      e('select', { value, onChange: ev => onChange(ev.target.value),
        style:{ background:'#0d1117', border:'1px solid #30363d', borderRadius:6, color:'#c9d1d9', padding:'5px 8px', fontSize:'.85rem', appearance:'none' }
      },
        options.map(o => e('option', { key: o.value||o, value: o.value||o }, o.label||o))
      )
    );
  }
  function Check({ label, checked, onChange }) {
    return e('label', { style:{ display:'flex', alignItems:'center', gap:6, fontSize:'.85rem', color:'#c9d1d9', cursor:'pointer' } },
      e('input', { type:'checkbox', checked, onChange: ev => onChange(ev.target.checked) }),
      label
    );
  }
  function Textarea({ label, value, onChange, rows=3, placeholder }) {
    return e('label', { style:{ display:'flex', flexDirection:'column', gap:3, fontSize:'.8rem', color:'#8b949e' } },
      label,
      e('textarea', {
        value, onChange: ev => onChange(ev.target.value), rows, placeholder,
        style:{ background:'#0d1117', border:'1px solid #30363d', borderRadius:6, color:'#c9d1d9', padding:'5px 8px', fontSize:'.8rem', fontFamily:'monospace', resize:'vertical' }
      })
    );
  }
  function BtnPrimary({ children, onClick, disabled }) {
    return e('button', { onClick, disabled,
      style:{ background:'#CC1212', color:'#fff', border:'none', borderRadius:6, padding:'5px 12px', cursor:disabled?'not-allowed':'pointer', fontSize:'.82rem', fontWeight:600, opacity:disabled?.6:1 }
    }, children);
  }
  function BtnSecondary({ children, onClick }) {
    return e('button', { onClick,
      style:{ background:'transparent', color:'#8b949e', border:'1px solid #30363d', borderRadius:6, padding:'5px 10px', cursor:'pointer', fontSize:'.82rem' }
    }, children);
  }
  function BtnDanger({ children, onClick }) {
    return e('button', { onClick,
      style:{ background:'transparent', color:'#f85149', border:'1px solid #f8514955', borderRadius:6, padding:'4px 8px', cursor:'pointer', fontSize:'.78rem' }
    }, children);
  }
  function SectionTitle({ children }) {
    return e('div', { className:'panel-title', style:{marginTop:20} }, children);
  }
  function FormCard({ children, onSubmit }) {
    return e('form', { onSubmit: ev => { ev.preventDefault(); onSubmit(); },
      style:{ background:'#1c2128', border:'1px solid #30363d', borderRadius:10, padding:'16px', marginBottom:12 }
    }, children);
  }
  function FormGrid({ children }) {
    return e('div', { style:{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px,1fr))', gap:'10px', marginBottom:12 } }, children);
  }

  // ── Paginação reutilizável ───────────────────────────────────────────────────
  function usePage(items, pageSize) {
    const [page, setPage] = React.useState(1);
    const total = Math.max(1, Math.ceil(items.length / pageSize));
    const clamp = Math.min(page, total);
    React.useEffect(() => { if (clamp !== page) setPage(clamp); }, [clamp]);
    const start = (clamp - 1) * pageSize;
    return { page: clamp, setPage, total, pageItems: items.slice(start, start + pageSize) };
  }

  const PAGE_SIZES = [10, 25, 50, 100];

  function Pager({ page, total, count, setPage, pageSize, setPageSize }) {
    const S = { color:'#8b949e', fontSize:'.78rem' };
    const Btn = ({ children, onClick, disabled }) =>
      e('button', { onClick, disabled,
        style:{ background:'transparent', border:'1px solid #30363d', borderRadius:5, padding:'3px 10px', color:disabled?'#334155':'#8b949e', cursor:disabled?'not-allowed':'pointer', fontSize:'.8rem' }
      }, children);
    return e('div', { style:{ display:'flex', alignItems:'center', gap:8, padding:'8px 0', flexWrap:'wrap' } },
      e(Btn, { onClick:()=>setPage(1),        disabled:page<=1 }, '«'),
      e(Btn, { onClick:()=>setPage(p=>p-1),  disabled:page<=1 }, '‹ Anterior'),
      e('span', { style:S }, 'Pág. '+page+' / '+total+' — '+count+' itens'),
      e(Btn, { onClick:()=>setPage(p=>p+1),  disabled:page>=total }, 'Próxima ›'),
      e(Btn, { onClick:()=>setPage(total),   disabled:page>=total }, '»'),
      setPageSize
        ? e('select', { value:pageSize, 'aria-label':'Itens por página', onChange:ev=>{ setPageSize(Number(ev.target.value)); setPage(1); },
            style:{ background:'#0d1117', border:'1px solid #30363d', borderRadius:5, color:'#8b949e', padding:'3px 6px', fontSize:'.78rem', marginLeft:4 }
          }, PAGE_SIZES.map(n => e('option',{key:n,value:n}, n+'/pág.')))
        : null
    );
  }

  function sortItems(items, sort, getters) {
    if (!sort || !sort.key || !getters[sort.key]) return items.slice();
    const dir = sort.dir === 'desc' ? -1 : 1;
    const read = getters[sort.key];
    return items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const a = read(left.item);
        const b = read(right.item);
        let cmp = 0;
        if (typeof a === 'boolean' || typeof b === 'boolean') {
          cmp = Number(Boolean(a)) - Number(Boolean(b));
        } else if (typeof a === 'number' && typeof b === 'number') {
          cmp = a - b;
        } else {
          const aDate = typeof a === 'string' && /[-:T]/.test(a) ? Date.parse(a) : NaN;
          const bDate = typeof b === 'string' && /[-:T]/.test(b) ? Date.parse(b) : NaN;
          if (!Number.isNaN(aDate) && !Number.isNaN(bDate)) {
            cmp = aDate - bDate;
          } else {
            cmp = String(a || '').localeCompare(String(b || ''), 'pt-BR', { numeric:true, sensitivity:'base' });
          }
        }
        return cmp === 0 ? left.index - right.index : cmp * dir;
      })
      .map(entry => entry.item);
  }

  function SortTh({ label, sortKey, sort, onSort }) {
    const active = sort.key === sortKey;
    const mark = active ? (sort.dir === 'asc' ? ' ^' : ' v') : '';
    return e('th', null,
      e('button', {
        type:'button',
        onClick:() => onSort(sortKey),
        style:{ background:'transparent', border:'none', color:active?'#c9d1d9':'#8b949e', padding:0, cursor:'pointer', fontSize:'11px', fontWeight:700, textTransform:'uppercase', letterSpacing:'.04em' },
        title:'Ordenar por '+label,
      }, label + mark)
    );
  }

  // ── Progress pipeline ────────────────────────────────────────────────────────
  const STAGE_LABEL = { policy:'Política', run_create:'Criando run', targets:'Listando alvos', scanning:'Varredura ativa', docker:'Docker', topology:'Topologia', prometheus_sd:'Prometheus SD', icinga:'Icinga', done:'Concluído' };
  const STAGE_ORDER = ['policy','run_create','targets','scanning','docker','topology','prometheus_sd','icinga','done'];

  function PipelinePanel({ progress }) {
    if (!progress || (!progress.active && !progress.summary)) return null;
    const elapsed = progress.elapsed_ms ? (progress.elapsed_ms/1000).toFixed(1)+'s' : '';
    const stMap = progress.stages || {};
    return e('div', { style:{ background:'#0f172a', border:'1px solid #334155', borderRadius:10, padding:'12px 14px', marginBottom:14 } },
      e('div', { style:{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 } },
        e('span', { style:{ fontWeight:600, fontSize:'.88rem', color:'#e2e8f0' } }, progress.active ? '⟳ Varredura em andamento' : '✓ Última varredura'),
        elapsed ? e('span', { style:{ fontSize:'.75rem', color:'#64748b' } }, elapsed) : null
      ),
      e('div', { style:{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(130px,1fr))', gap:6 } },
        STAGE_ORDER.map(s => {
          const st = stMap[s] || 'pending';
          const icon = st==='done'?'✓':st==='running'?'◎':st==='skipped'?'—':st==='error'?'✗':'○';
          const col  = st==='done'?'#3fb950':st==='running'?'#f59e0b':st==='skipped'?'#475569':st==='error'?'#f85149':'#334155';
          const txtCol = st==='pending'?'#475569':'#e2e8f0';
          return e('div', { key:s, style:{ display:'flex', alignItems:'center', gap:5, border:'1px solid '+(st==='running'?'#f59e0b44':'#1e293b'), borderRadius:5, padding:'4px 7px', background:st==='running'?'rgba(245,158,11,.07)':'transparent' } },
            e('span', { style:{ color:col, fontSize:'.82rem', fontWeight:700, flexShrink:0 } }, icon),
            e('span', { style:{ fontSize:'.74rem', color:txtCol } }, STAGE_LABEL[s]||s)
          );
        })
      ),
      (progress.total_targets > 0 || progress.discovered > 0) ? e('div', { style:{ display:'flex', gap:16, marginTop:8, paddingTop:8, borderTop:'1px solid #1e293b', flexWrap:'wrap' } },
        e('span', { style:{ fontSize:'.78rem', color:'#94a3b8' } }, 'Alvos: ', e('b', { style:{color:'#e2e8f0'} }, String(progress.scanned||0)+(progress.total_targets?'/'+progress.total_targets:''))),
        e('span', { style:{ fontSize:'.78rem', color:'#94a3b8' } }, 'Descobertos: ', e('b', { style:{color:'#3fb950'} }, String(progress.discovered||0)))
      ) : null
    );
  }

  // ── Aba: Descoberta ──────────────────────────────────────────────────────────
  function DiscoveryTab({ data, scanning, progress, scanMsg, onScan, scope, setScope, scopeOptions }) {
    const { assets=[], runs=[], findings=[], fingerprints=[], topology=[] } = data;
    const [assetSearch, setAssetSearch] = React.useState('');
    const [assetState, setAssetState]   = React.useState('all');
    const [pageSize, setPageSize]       = React.useState(25);
    const [assetSort, setAssetSort]     = React.useState({ key:'name', dir:'asc' });
    const [findingSearch, setFindingSearch]     = React.useState('');
    const [findingSeverity, setFindingSeverity] = React.useState('all');
    const [findingPageSize, setFindingPageSize] = React.useState(10);
    const [findingSort, setFindingSort]         = React.useState({ key:'type', dir:'asc' });
    const [runSearch, setRunSearch]     = React.useState('');
    const [runStatus, setRunStatus]     = React.useState('all');
    const [runPageSize, setRunPageSize] = React.useState(10);
    const [runSort, setRunSort]         = React.useState({ key:'started_at', dir:'desc' });
    const now = Date.now();
    const newCount       = assets.filter(a => (now - new Date(a.updated_at).getTime()) < 86400000).length;
    const disappearedCnt = assets.filter(a => a.lifecycle_state === 'disappeared').length;
    const changedCnt     = findings.filter(f => String(f.finding_type||'').includes('changed')).length;
    const lastRunStatus  = runs[0]?.status || '-';
    const lastRunSummary = runs[0]?.summary || {};
    const filteredAssets = assets.filter(a => {
      const stOk = assetState === 'all' || a.lifecycle_state === assetState;
      const srOk = !assetSearch || (a.display_name||a.asset_name||'').toLowerCase().includes(assetSearch.toLowerCase()) || (a.primary_ip||'').includes(assetSearch);
      return stOk && srOk;
    });
    const sortedAssets = sortItems(filteredAssets, assetSort, {
      name: a => a.display_name || a.asset_name || '',
      ip: a => a.primary_ip || '',
      vendor: a => a.vendor || '',
      product: a => a.product || '',
      state: a => a.lifecycle_state || '',
    });
    const filteredFindings = findings.filter(f => {
      const sevOk = findingSeverity === 'all' || String(f.severity || '').toLowerCase() === findingSeverity;
      const srOk = !findingSearch || [f.finding_type, f.source, f.severity].some(v => String(v || '').toLowerCase().includes(findingSearch.toLowerCase()));
      return sevOk && srOk;
    });
    const sortedFindings = sortItems(filteredFindings, findingSort, {
      type: f => FINDING_TYPE[String(f.finding_type || '').toLowerCase()] || String(f.finding_type || ''),
      severity: f => f.severity || '',
      source: f => f.source || '',
    });
    const filteredRuns = runs.filter(r => {
      const statusOk = runStatus === 'all' || String(r.status || '').toLowerCase() === runStatus;
      const srOk = !runSearch || [r.status, r.started_at, r.completed_at].some(v => String(v || '').toLowerCase().includes(runSearch.toLowerCase()));
      return statusOk && srOk;
    });
    const sortedRuns = sortItems(filteredRuns, runSort, {
      status: r => r.status || '',
      started_at: r => r.started_at || '',
      completed_at: r => r.completed_at || '',
    });
    const { page: aPage, setPage: setAPage, total: aTotal, pageItems: aItems } = usePage(sortedAssets, pageSize);
    const { page: fPage, setPage: setFPage, total: fTotal, pageItems: fItems } = usePage(sortedFindings, findingPageSize);
    const { page: rPage, setPage: setRPage, total: rTotal, pageItems: rItems } = usePage(sortedRuns, runPageSize);

    function toggleSort(setSort, setPage, key) {
      setSort(current => current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' });
      setPage(1);
    }

    function comboOptions(current, values) {
      const list = [current, ...(values || []).filter(v => v !== current)];
      return list.filter(Boolean).map(v => ({ value:v, label:v }));
    }

    return e('div', null,
      e('div', { className:'hero' },
        e('div', null,
          e('h1', null, 'Descoberta Contínua e Autônoma'),
          e('div', { className:'sub' }, 'Inventário vivo, identificação de serviços e topologia operacional')
        ),
        e('button', { className:'btn', onClick: onScan, disabled: scanning },
          scanning ? e('span', { className:'spinner' }) : null,
          scanning ? ' Executando…' : 'Executar varredura'
        )
      ),
      e('div', { className:'filters' },
        e(Select, { label:'tenant_id', value:scope.tenant, onChange:v=>setScope({...scope,tenant:v}), options:comboOptions(scope.tenant, scopeOptions?.tenants), style:{minWidth:160} }),
        e(Select, { label:'site_id', value:scope.site, onChange:v=>setScope({...scope,site:v}), options:comboOptions(scope.site, scopeOptions?.sites), style:{minWidth:160} }),
        e(Select, { label:'edge_id', value:scope.edge, onChange:v=>setScope({...scope,edge:v}), options:comboOptions(scope.edge, scopeOptions?.edges), style:{minWidth:160} })
      ),
      scanMsg ? e('div', { className:'scan-feedback '+(scanMsg.type), style:{marginBottom:8} }, scanMsg.text) : null,
      e(PipelinePanel, { progress }),
      e('div', { className:'grid', style:{marginBottom:12} },
        e('div', { className:'card' }, e('div', { className:'k' }, 'Ativos'), e('div', { className:'v' }, String(assets.length))),
        e('div', { className:'card' }, e('div', { className:'k' }, 'Execuções'), e('div', { className:'v' }, String(runs.length))),
        e('div', { className:'card' }, e('div', { className:'k' }, 'Última execução'), e('div', { className:'v' }, runBadge(lastRunStatus))),
        e('div', { className:'card' }, e('div', { className:'k' }, 'Novos (24h)'), e('div', { className:'v' }, String(newCount))),
        e('div', { className:'card' }, e('div', { className:'k' }, 'Alterados'), e('div', { className:'v' }, String(changedCnt))),
        e('div', { className:'card' }, e('div', { className:'k' }, 'Desaparecidos'), e('div', { className:'v' }, String(disappearedCnt)))
      ),
      lastRunSummary.scanned_targets ? e('div', { style:{fontSize:'.8rem',color:'#8b949e',marginBottom:8} },
        'Última varredura: ', String(lastRunSummary.scanned_targets), ' alvos · ', String(lastRunSummary.discovered_assets), ' ativos · ', String(lastRunSummary.topology_edges), ' arestas'
      ) : null,
      e(SectionTitle, null, 'Ativos'),
      e('div', { style:{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap', alignItems:'center' } },
        e(Input, { label:'Buscar por nome ou IP', value:assetSearch, onChange:v=>{ setAssetSearch(v); setAPage(1); }, placeholder:'10.10.2.1', style:{ flex:1, minWidth:180 } }),
        e(Select, { label:'Estado', value:assetState, onChange:v=>{ setAssetState(v); setAPage(1); }, options:[{value:'all',label:'Todos os estados'}, ...LIFECYCLE_OPTS.map(o => ({ value:o, label:tr(ESTADO,o) }))], style:{ minWidth:180 } }),
        e('span', { style:{ fontSize:'.78rem', color:'#64748b', alignSelf:'end', paddingBottom:4 } }, filteredAssets.length+' ativos')
      ),
      e('table', null,
        e('thead', null, e('tr', null,
          e(SortTh, { label:'Ativo', sortKey:'name', sort:assetSort, onSort:key => toggleSort(setAssetSort, setAPage, key) }),
          e(SortTh, { label:'IP', sortKey:'ip', sort:assetSort, onSort:key => toggleSort(setAssetSort, setAPage, key) }),
          e(SortTh, { label:'Fabricante', sortKey:'vendor', sort:assetSort, onSort:key => toggleSort(setAssetSort, setAPage, key) }),
          e(SortTh, { label:'Produto', sortKey:'product', sort:assetSort, onSort:key => toggleSort(setAssetSort, setAPage, key) }),
          e(SortTh, { label:'Estado', sortKey:'state', sort:assetSort, onSort:key => toggleSort(setAssetSort, setAPage, key) })
        )),
        e('tbody', null,
          aItems.length === 0 ? e('tr',null, e('td',{colSpan:5,style:{textAlign:'center',color:'#8b949e',padding:'1.5rem'}},'Nenhum ativo encontrado.')) : null,
          aItems.map(a => e('tr', { key:a.id },
            e('td', null, a.display_name||a.asset_name),
            e('td', null, a.primary_ip||'—'),
            e('td', null, a.vendor&&a.vendor!=='Unknown'?a.vendor:'—'),
            e('td', null, a.product&&a.product!=='Unknown'?a.product:'—'),
            e('td', null, estadoBadge(a.lifecycle_state))
          ))
        )
      ),
      e(Pager, { page:aPage, total:aTotal, count:filteredAssets.length, setPage:setAPage, pageSize, setPageSize }),
      e('div', { className:'split', style:{marginTop:10} },
        e('div', null,
          e(SectionTitle, null, 'Ocorrências'),
          e('div', { style:{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap', alignItems:'center' } },
            e(Input, { label:'Buscar tipo, gravidade ou fonte', value:findingSearch, onChange:v=>{ setFindingSearch(v); setFPage(1); }, placeholder:'Erro Prometheus SD', style:{ flex:1, minWidth:180 } }),
            e(Select, { label:'Gravidade', value:findingSeverity, onChange:v=>{ setFindingSeverity(v); setFPage(1); }, options:[{value:'all',label:'Todas as gravidades'}, ...Object.keys(SEVERITY).map(o => ({ value:o, label:tr(SEVERITY,o) }))], style:{ minWidth:180 } }),
            e('span', { style:{ fontSize:'.78rem', color:'#64748b', alignSelf:'end', paddingBottom:4 } }, filteredFindings.length+' ocorrências')
          ),
          e('table', null,
            e('thead', null, e('tr', null,
              e(SortTh, { label:'Tipo', sortKey:'type', sort:findingSort, onSort:key => toggleSort(setFindingSort, setFPage, key) }),
              e(SortTh, { label:'Gravidade', sortKey:'severity', sort:findingSort, onSort:key => toggleSort(setFindingSort, setFPage, key) }),
              e(SortTh, { label:'Fonte', sortKey:'source', sort:findingSort, onSort:key => toggleSort(setFindingSort, setFPage, key) })
            )),
            e('tbody', null,
              fItems.length === 0 ? e('tr', null, e('td', { colSpan:3, style:{textAlign:'center',color:'#8b949e',padding:'1.5rem'} }, 'Nenhuma ocorrência encontrada.')) : null,
              fItems.map(f => e('tr', { key:f.id },
                e('td', null, FINDING_TYPE[String(f.finding_type||'').toLowerCase()]||String(f.finding_type||'—').replace(/_/g,' ')),
                e('td', null, sevBadge(f.severity)),
                e('td', null, f.source||'—')
              ))
            )
          ),
          e(Pager, { page:fPage, total:fTotal, count:filteredFindings.length, setPage:setFPage, pageSize:findingPageSize, setPageSize:setFindingPageSize })
        ),
        e('div', null,
          e(SectionTitle, null, 'Execuções'),
          e('div', { style:{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap', alignItems:'center' } },
            e(Input, { label:'Buscar status ou datas', value:runSearch, onChange:v=>{ setRunSearch(v); setRPage(1); }, placeholder:'Concluído', style:{ flex:1, minWidth:180 } }),
            e(Select, { label:'Status', value:runStatus, onChange:v=>{ setRunStatus(v); setRPage(1); }, options:[{value:'all',label:'Todos os status'}, ...Object.keys(RUN_STATUS).map(o => ({ value:o, label:tr(RUN_STATUS,o) }))], style:{ minWidth:180 } }),
            e('span', { style:{ fontSize:'.78rem', color:'#64748b', alignSelf:'end', paddingBottom:4 } }, filteredRuns.length+' execuções')
          ),
          e('table', null,
            e('thead', null, e('tr', null,
              e(SortTh, { label:'Status', sortKey:'status', sort:runSort, onSort:key => toggleSort(setRunSort, setRPage, key) }),
              e(SortTh, { label:'Início', sortKey:'started_at', sort:runSort, onSort:key => toggleSort(setRunSort, setRPage, key) }),
              e(SortTh, { label:'Fim', sortKey:'completed_at', sort:runSort, onSort:key => toggleSort(setRunSort, setRPage, key) })
            )),
            e('tbody', null,
              rItems.length === 0 ? e('tr', null, e('td', { colSpan:3, style:{textAlign:'center',color:'#8b949e',padding:'1.5rem'} }, 'Nenhuma execução encontrada.')) : null,
              rItems.map(r => e('tr', { key:r.id },
                e('td', null, runBadge(r.status)),
                e('td', null, fmtDt(r.started_at)),
                e('td', null, fmtDt(r.completed_at))
              ))
            )
          ),
          e(Pager, { page:rPage, total:rTotal, count:filteredRuns.length, setPage:setRPage, pageSize:runPageSize, setPageSize:setRunPageSize })
        )
      )
    );
  }

  // ── Aba: Políticas ───────────────────────────────────────────────────────────
  const EMPTY_POLICY = { name:'', scan_profile:'safe', active_enabled:true, passive_enabled:true, allowed_ranges:'', blocked_ranges:'', max_rate_per_minute:300, host_timeout_ms:12000, max_concurrency:5, allow_udp:false, auto_prometheus_sd:true, auto_icinga_sync:true, is_default:false };

  function PoliciesTab({ data, scope, reload }) {
    const { policies=[] } = data;
    const [showForm, setShowForm]   = React.useState(false);
    const [form, setForm]           = React.useState({ ...EMPTY_POLICY });
    const [editId, setEditId]       = React.useState(null);
    const [feedback, setFeedback]   = React.useState('');
    const [searchName, setSearchName] = React.useState('');
    const [pageSize, setPageSize]   = React.useState(10);
    const [sort, setSort]           = React.useState({ key:'name', dir:'asc' });
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const filteredPol = policies.filter(p => !searchName || p.name.toLowerCase().includes(searchName.toLowerCase()));
    const sortedPol = sortItems(filteredPol, sort, {
      name: p => p.name || '',
      scan_profile: p => p.scan_profile || '',
      max_rate_per_minute: p => p.max_rate_per_minute || 0,
      max_concurrency: p => p.max_concurrency || 0,
      auto_prometheus_sd: p => p.auto_prometheus_sd === true,
      is_default: p => p.is_default === true,
    });
    const { page: pPage, setPage: setPPage, total: pTotal, pageItems: pItems } = usePage(sortedPol, pageSize);

    function toggleSort(key) {
      setSort(current => current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' });
      setPPage(1);
    }

    function parseRanges(str) {
      try {
        const trimmed = str.trim();
        if (trimmed.startsWith('[')) return JSON.parse(trimmed);
        return trimmed.split('\\n').map(s=>s.trim()).filter(Boolean);
      } catch { return []; }
    }

    async function save() {
      const body = {
        ...scope,
        ...form,
        allowed_ranges: parseRanges(form.allowed_ranges),
        blocked_ranges: parseRanges(form.blocked_ranges),
      };
      const headers = { 'Content-Type':'application/json' };
      const url = editId ? API+'/policies/'+editId : API+'/policies';
      const method = editId ? 'PATCH' : 'POST';
      const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { setFeedback('✗ '+( d.error||r.status)); return; }
      setFeedback('✓ Salvo com sucesso');
      setShowForm(false); setEditId(null); setForm({...EMPTY_POLICY});
      reload();
    }

    function startEdit(p) {
      setForm({
        name: p.name, scan_profile: p.scan_profile,
        active_enabled: p.active_enabled, passive_enabled: p.passive_enabled,
        allowed_ranges: (p.allowed_ranges||[]).join('\\n'),
        blocked_ranges: (p.blocked_ranges||[]).join('\\n'),
        max_rate_per_minute: p.max_rate_per_minute||300,
        host_timeout_ms: p.host_timeout_ms||12000,
        max_concurrency: p.max_concurrency||5,
        allow_udp: p.allow_udp||false,
        auto_prometheus_sd: p.auto_prometheus_sd!==false,
        auto_icinga_sync: p.auto_icinga_sync||false,
        is_default: p.is_default||false,
      });
      setEditId(p.id); setShowForm(true); setFeedback('');
    }

    async function del(p) {
      if (!confirm('Excluir política "'+p.name+'"?')) return;
      const r = await fetch(API+'/policies/'+p.id, { method:'DELETE', headers:{} });
      if (!r.ok) { setFeedback('✗ Erro ao excluir'); return; }
      setFeedback('✓ Excluída: '+p.name);
      reload();
    }

    return e('div', null,
      e('div', { style:{ display:'flex', alignItems:'center', gap:8, marginBottom:8, flexWrap:'wrap' } },
        e('h2', { style:{ fontSize:'1.1rem', margin:0, flex:1 } }, 'Políticas de Varredura'),
        e(Input, { label:'Buscar por nome', value:searchName, onChange:v=>{ setSearchName(v); setPPage(1); }, placeholder:'default-safe', style:{ width:220 } }),
        e(BtnPrimary, { onClick: () => { setShowForm(!showForm); setEditId(null); setForm({...EMPTY_POLICY}); setFeedback(''); } },
          showForm && !editId ? 'Cancelar' : '+ Nova Política'
        )
      ),
      e(Feedback, { msg: feedback }),
      (showForm) ? e(FormCard, { onSubmit: save },
        e('div', { style:{ fontWeight:600, marginBottom:10, color:'#c9d1d9' } }, editId ? 'Editar Política' : 'Nova Política'),
        e(FormGrid, null,
          e(Input, { label:'Nome *', value:form.name, onChange:v=>set('name',v), required:true }),
          e(Select, { label:'Perfil', value:form.scan_profile, onChange:v=>set('scan_profile',v), options:PROFILE_OPTS }),
          e(Input, { label:'Taxa máx/min', value:form.max_rate_per_minute, onChange:v=>set('max_rate_per_minute',Number(v)), type:'number' }),
          e(Input, { label:'Timeout host (ms)', value:form.host_timeout_ms, onChange:v=>set('host_timeout_ms',Number(v)), type:'number' }),
          e(Input, { label:'Concorrência máx', value:form.max_concurrency, onChange:v=>set('max_concurrency',Number(v)), type:'number' })
        ),
        e(Textarea, { label:'Ranges permitidos (um por linha)', value:form.allowed_ranges, onChange:v=>set('allowed_ranges',v), placeholder:'10.0.0.0/8\\n192.168.0.0/16\\n172.16.0.0/12', rows:3 }),
        e('div', { style:{ height:8 } }),
        e(Textarea, { label:'Ranges bloqueados (um por linha)', value:form.blocked_ranges, onChange:v=>set('blocked_ranges',v), placeholder:'10.0.0.0/8', rows:2 }),
        e('div', { style:{ display:'flex', flexWrap:'wrap', gap:16, marginTop:12 } },
          e(Check, { label:'Scan ativo', checked:form.active_enabled, onChange:v=>set('active_enabled',v) }),
          e(Check, { label:'Passivo', checked:form.passive_enabled, onChange:v=>set('passive_enabled',v) }),
          e(Check, { label:'UDP', checked:form.allow_udp, onChange:v=>set('allow_udp',v) }),
          e(Check, { label:'Auto Prometheus SD', checked:form.auto_prometheus_sd, onChange:v=>set('auto_prometheus_sd',v) }),
          e(Check, { label:'Auto Icinga sync', checked:form.auto_icinga_sync, onChange:v=>set('auto_icinga_sync',v) }),
          e(Check, { label:'Padrão', checked:form.is_default, onChange:v=>set('is_default',v) })
        ),
        e('div', { style:{ display:'flex', gap:8, marginTop:14 } },
          e(BtnPrimary, { onClick: save }, editId ? 'Atualizar' : 'Criar Política'),
          e(BtnSecondary, { onClick: () => { setShowForm(false); setEditId(null); setForm({...EMPTY_POLICY}); } }, 'Cancelar')
        )
      ) : null,
      e('table', null,
        e('thead', null, e('tr', null,
          e(SortTh, { label:'Nome', sortKey:'name', sort, onSort:toggleSort }),
          e(SortTh, { label:'Perfil', sortKey:'scan_profile', sort, onSort:toggleSort }),
          e(SortTh, { label:'Taxa/min', sortKey:'max_rate_per_minute', sort, onSort:toggleSort }),
          e(SortTh, { label:'Conc.', sortKey:'max_concurrency', sort, onSort:toggleSort }),
          e(SortTh, { label:'SD', sortKey:'auto_prometheus_sd', sort, onSort:toggleSort }),
          e(SortTh, { label:'Padrão', sortKey:'is_default', sort, onSort:toggleSort }),
          e('th',null,'')
        )),
        e('tbody', null,
          pItems.length === 0 ? e('tr', null, e('td', { colSpan:7, style:{textAlign:'center',color:'#8b949e',padding:'2rem'} }, 'Nenhuma política encontrada.')) : null,
          pItems.map(p => e('tr', { key:p.id },
            e('td', null, p.name),
            e('td', null, badge(p.scan_profile==='aggressive'?'critical':p.scan_profile==='balanced'?'warning':'ok', p.scan_profile)),
            e('td', null, p.max_rate_per_minute),
            e('td', null, p.max_concurrency),
            e('td', null, p.auto_prometheus_sd ? '✓' : '—'),
            e('td', null, p.is_default ? badge('ok','sim') : '—'),
            e('td', null,
              e('div', { style:{display:'flex',gap:6} },
                e(BtnSecondary, { onClick: ()=>startEdit(p) }, 'Editar'),
                p.is_default ? null : e(BtnDanger, { onClick: ()=>del(p) }, 'Excluir')
              )
            )
          ))
        )
      ),
      e(Pager, { page:pPage, total:pTotal, count:filteredPol.length, setPage:setPPage, pageSize, setPageSize })
    );
  }

  // ── Aba: Targets ─────────────────────────────────────────────────────────────
  const EMPTY_TARGET = { address:'', discovery_type:'ip', label:'', enabled:true, policy_id:'' };

  function TargetsTab({ data, scope, reload }) {
    const { targets=[], policies=[] } = data;
    const [showForm, setShowForm] = React.useState(false);
    const [form, setForm] = React.useState({ ...EMPTY_TARGET });
    const [editId, setEditId] = React.useState(null);
    const [feedback, setFeedback] = React.useState('');
    const [filterEnabled, setFilterEnabled] = React.useState('all');
    const [filterType, setFilterType]       = React.useState('all');
    const [searchAddr, setSearchAddr]       = React.useState('');
    const [pageSize, setPageSize]           = React.useState(25);
    const [sort, setSort]                   = React.useState({ key:'address', dir:'asc' });
    const set = (k,v) => setForm(f => ({...f,[k]:v}));

    async function save() {
      const body = { ...scope, ...form };
      if (!body.address) { setFeedback('✗ address é obrigatório'); return; }
      if (!body.policy_id) delete body.policy_id;
      const headers = { 'Content-Type':'application/json' };
      const url = editId ? API+'/targets/'+editId : API+'/targets';
      const method = editId ? 'PATCH' : 'POST';
      const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { setFeedback('✗ '+(d.error||r.status)); return; }
      setFeedback('✓ Salvo: '+body.address);
      setShowForm(false); setEditId(null); setForm({...EMPTY_TARGET});
      reload();
    }

    function startEdit(t) {
      setForm({ address:t.address, discovery_type:t.discovery_type||'ip', label:t.label||'', enabled:t.enabled!==false, policy_id:t.policy_id||'' });
      setEditId(t.id); setShowForm(true); setFeedback('');
    }

    async function del(t) {
      if (!confirm('Excluir target "'+t.address+'"?')) return;
      const r = await fetch(API+'/targets/'+t.id, { method:'DELETE', headers:{} });
      if (!r.ok) { setFeedback('✗ Erro ao excluir'); return; }
      setFeedback('✓ Excluído: '+t.address);
      reload();
    }

    async function toggleEnabled(t) {
      const r = await fetch(API+'/targets/'+t.id, { method:'PATCH',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ enabled: !t.enabled })
      });
      if (r.ok) reload();
    }

    const filtered = targets.filter(t => {
      const enOk   = filterEnabled === 'all' || String(t.enabled) === filterEnabled;
      const typeOk = filterType    === 'all' || t.discovery_type === filterType;
      const srOk   = !searchAddr   || (t.address||'').toLowerCase().includes(searchAddr.toLowerCase()) || (t.label||'').toLowerCase().includes(searchAddr.toLowerCase());
      return enOk && typeOk && srOk;
    });
    const sorted = sortItems(filtered, sort, {
      address: t => t.address || '',
      discovery_type: t => t.discovery_type || '',
      label: t => t.label || '',
      policy_name: t => t.policy_name || '',
      enabled: t => t.enabled === true,
    });
    const { page: tPage, setPage: setTPage, total: tTotal, pageItems: tItems } = usePage(sorted, pageSize);
    const policyOpts = [{ value:'', label:'(sem política)' }, ...policies.map(p => ({ value:p.id, label:p.name }))];

    function toggleSort(key) {
      setSort(current => current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' });
      setTPage(1);
    }

    return e('div', null,
      e('div', { style:{ display:'flex', alignItems:'center', gap:8, marginBottom:8, flexWrap:'wrap' } },
        e('h2', { style:{ fontSize:'1.1rem', margin:0, flex:1 } }, 'Targets de Descoberta'),
        e(BtnPrimary, { onClick:()=>{ setShowForm(!showForm); setEditId(null); setForm({...EMPTY_TARGET}); setFeedback(''); } },
          showForm && !editId ? 'Cancelar' : '+ Novo Target'
        )
      ),
      e('div', { style:{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap', alignItems:'center' } },
        e(Input, { label:'Buscar endereço ou label', value:searchAddr, onChange:v=>{ setSearchAddr(v); setTPage(1); }, placeholder:'10.10.2.0/24', style:{ flex:1, minWidth:180 } }),
        e(Select, { label:'Tipo', value:filterType, onChange:v=>{ setFilterType(v); setTPage(1); }, options:[{value:'all',label:'Todos os tipos'}, ...TYPE_OPTS.map(o => ({ value:o, label:o }))], style:{ minWidth:170 } }),
        e(Select, { label:'Status', value:filterEnabled, onChange:v=>{ setFilterEnabled(v); setTPage(1); }, options:[{value:'all',label:'Todos'}, {value:'true',label:'Habilitados'}, {value:'false',label:'Desabilitados'}], style:{ minWidth:170 } }),
        e('span', { style:{ fontSize:'.78rem', color:'#64748b', alignSelf:'end', paddingBottom:4 } }, filtered.length+' targets')
      ),
      e(Feedback, { msg: feedback }),
      showForm ? e(FormCard, { onSubmit: save },
        e('div', { style:{ fontWeight:600, marginBottom:10, color:'#c9d1d9' } }, editId ? 'Editar Target' : 'Novo Target'),
        e(FormGrid, null,
          e(Input, { label:'Endereço *', value:form.address, onChange:v=>set('address',v), placeholder:'10.10.2.0/24 ou 192.168.1.1', required:true }),
          e(Select, { label:'Tipo', value:form.discovery_type, onChange:v=>set('discovery_type',v), options:TYPE_OPTS }),
          e(Input, { label:'Label (opcional)', value:form.label, onChange:v=>set('label',v), placeholder:'servidores-core' }),
          e(Select, { label:'Política', value:form.policy_id, onChange:v=>set('policy_id',v), options:policyOpts })
        ),
        e(Check, { label:'Habilitado', checked:form.enabled, onChange:v=>set('enabled',v) }),
        e('div', { style:{ display:'flex', gap:8, marginTop:14 } },
          e(BtnPrimary, { onClick:save }, editId ? 'Atualizar' : 'Criar Target'),
          e(BtnSecondary, { onClick:()=>{ setShowForm(false); setEditId(null); setForm({...EMPTY_TARGET}); } }, 'Cancelar')
        )
      ) : null,
      e('table', null,
        e('thead', null, e('tr', null,
          e(SortTh, { label:'Endereço', sortKey:'address', sort, onSort:toggleSort }),
          e(SortTh, { label:'Tipo', sortKey:'discovery_type', sort, onSort:toggleSort }),
          e(SortTh, { label:'Label', sortKey:'label', sort, onSort:toggleSort }),
          e(SortTh, { label:'Política', sortKey:'policy_name', sort, onSort:toggleSort }),
          e(SortTh, { label:'Status', sortKey:'enabled', sort, onSort:toggleSort }),
          e('th',null,'')
        )),
        e('tbody', null,
          tItems.length === 0 ? e('tr', null, e('td', { colSpan:6, style:{textAlign:'center',color:'#8b949e',padding:'2rem'} }, 'Nenhum target encontrado.')) : null,
          tItems.map(t => e('tr', { key:t.id },
            e('td', null, e('code', { style:{color:'#58a6ff',fontSize:'.82rem'} }, t.address)),
            e('td', null, t.discovery_type),
            e('td', null, t.label||'—'),
            e('td', null, t.policy_name||'—'),
            e('td', null, t.enabled ? badge('ok','ativo') : badge('disabled','inativo')),
            e('td', null,
              e('div', { style:{display:'flex',gap:6} },
                e(BtnSecondary, { onClick:()=>startEdit(t) }, 'Editar'),
                e(BtnSecondary, { onClick:()=>toggleEnabled(t) }, t.enabled ? 'Desabilitar' : 'Habilitar'),
                e(BtnDanger, { onClick:()=>del(t) }, 'Excluir')
              )
            )
          ))
        )
      ),
      e(Pager, { page:tPage, total:tTotal, count:filtered.length, setPage:setTPage, pageSize, setPageSize })
    );
  }

  // ── Aba: Serviços ──────────────────────────────────────────────────────────
  function ServicesTab({ data, scope, reload }) {
    const { services=[], assets=[] } = data;
    const [search, setSearch] = React.useState('');
    const [pageSize, setPageSize] = React.useState(25);
    const [sort, setSort] = React.useState({ key:'asset', dir:'asc' });
    const [currentPage, setCurrentPage] = React.useState(1);

    const assetMap = React.useMemo(() => {
      const m = {};
      for (const a of assets) m[a.id] = a;
      return m;
    }, [assets]);

    const filtered = services.filter(s => {
      const asset = assetMap[s.asset_id];
      const name = asset?.asset_name || s.service_key;
      return !search || name.toLowerCase().includes(search.toLowerCase()) || s.service_key.toLowerCase().includes(search.toLowerCase());
    });

    const sorted = [...filtered].sort((a,b) => {
      const aname = (assetMap[a.asset_id]?.asset_name || '');
      const bname = (assetMap[b.asset_id]?.asset_name || '');
      const mod = sort.dir === 'asc' ? 1 : -1;
      if (sort.key === 'asset') return aname.localeCompare(bname) * mod;
      if (sort.key === 'port') return (a.port - b.port) * mod;
      return 0;
    });
    const total = sorted.length;
    const start = (currentPage-1)*pageSize;
    const items = sorted.slice(start, start+pageSize);

    function toggleSort(key) {
      setSort(s => s.key===key ? {key, dir: s.dir==='asc'?'desc':'asc'} : {key, dir:'asc'});
      setCurrentPage(1);
    }

    return e('div', null,
      e('div', { style:{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap', alignItems:'center' } },
        e(Input, { label:'Buscar por nome ou serviço', value:search, onChange:v=>{ setSearch(v); setCurrentPage(1); }, placeholder:'postgres ou 5432', style:{ flex:1, minWidth:200 } }),
        e('span', { style:{ fontSize:'.78rem', color:'#64748b', alignSelf:'end', paddingBottom:4 } }, filtered.length+' serviços')
      ),
      e('table', null,
        e('thead', null, e('tr', null,
          e(SortTh, { label:'Ativo', sortKey:'asset', sort, onSort:toggleSort }),
          e('th', null, 'IP'),
          e(SortTh, { label:'Porta', sortKey:'port', sort, onSort:toggleSort }),
          e('th', null, 'Protocolo'),
          e('th', null, 'Serviço'),
          e('th', null, 'Status')
        )),
        e('tbody', null,
          items.length === 0 ? e('tr', null, e('td', { colSpan:6, style:{textAlign:'center',color:'#8b949e',padding:'2rem'} }, 'Nenhum serviço encontrado.')) : null,
          items.map(s => {
            const asset = assetMap[s.asset_id];
            const fp = (typeof s.fingerprint === 'string' ? JSON.parse(s.fingerprint || '{}') : (s.fingerprint || {}));
            const tech = fp.technology || '';
            const banner = fp.banner ? String(fp.banner).slice(0,60) : '';
            const product = fp.product_hint || fp.product || '';
            return e('tr', { key:s.id },
              e('td', null, asset?.asset_name || '—'),
              e('td', null, e('code', { style:{color:'#58a6ff',fontSize:'.8rem'} }, asset?.primary_ip || '—')),
              e('td', null, s.port),
              e('td', null, (s.protocol||'tcp').toUpperCase()),
              e('td', null, e('span', { title:banner }, tech || product || s.service_name || s.service_key)),
              e('td', null, banner ? e('code', { style:{fontSize:'.7rem',color:'#7ee787'} }, banner) : '—'),
              e('td', null, badge(s.status, s.status))
            );
          })
        )
      ),
      total > pageSize ? e(Pager, { page:currentPage, total:Math.ceil(total/pageSize), count:total, setPage:setCurrentPage, pageSize, setPageSize }) : null
    );
  }

  // ── Aba: Ativos ──────────────────────────────────────────────────────────────
  function AssetsTab({ data, scope, reload }) {
    const { assets=[] } = data;
    const [filterState, setFilterState]       = React.useState('all');
    const [filterCrit, setFilterCrit]         = React.useState('all');
    const [filterName, setFilterName]         = React.useState('');
    const [pageSize, setPageSize]             = React.useState(25);
    const [sort, setSort]                     = React.useState({ key:'name', dir:'asc' });
    const [feedback, setFeedback]             = React.useState('');
    const [editing, setEditing]               = React.useState(null);

    async function patchAsset(id, body) {
      const r = await fetch(API+'/assets/'+id, { method:'PATCH',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) { setFeedback('✗ '+(d.error||r.status)); return false; }
      return true;
    }

    async function saveEdit() {
      const { id, form } = editing;
      const ok = await patchAsset(id, form);
      if (ok) { setFeedback('✓ Ativo atualizado'); setEditing(null); reload(); }
    }

    const filtered = assets.filter(a => {
      const stateOk = filterState === 'all' || a.lifecycle_state === filterState;
      const critOk  = filterCrit  === 'all' || a.criticality === filterCrit;
      const nameOk  = !filterName || (a.display_name||a.asset_name||'').toLowerCase().includes(filterName.toLowerCase()) || (a.primary_ip||'').includes(filterName);
      return stateOk && critOk && nameOk;
    });
    const sorted = sortItems(filtered, sort, {
      name: a => a.display_name || a.asset_name || '',
      primary_ip: a => a.primary_ip || '',
      vendor_os: a => [a.vendor && a.vendor !== 'Unknown' ? a.vendor : null, a.os_hint].filter(Boolean).join(' / '),
      lifecycle_state: a => a.lifecycle_state || '',
      criticality: a => a.criticality || '',
    });
    const { page: aPage, setPage: setAPage, total: aTotal, pageItems: aItems } = usePage(sorted, pageSize);

    function toggleSort(key) {
      setSort(current => current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' });
      setAPage(1);
    }

    return e('div', null,
      e('div', { style:{ display:'flex', alignItems:'center', gap:8, marginBottom:8, flexWrap:'wrap' } },
        e('h2', { style:{ fontSize:'1.1rem', margin:0, flex:1 } }, 'Ativos Descobertos')
      ),
      e('div', { style:{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap', alignItems:'center' } },
        e(Input, { label:'Buscar por nome ou IP', value:filterName, onChange:v=>{ setFilterName(v); setAPage(1); }, placeholder:'10.10.2.1', style:{ flex:1, minWidth:180 } }),
        e(Select, { label:'Estado', value:filterState, onChange:v=>{ setFilterState(v); setAPage(1); }, options:[{value:'all',label:'Todos os estados'}, ...LIFECYCLE_OPTS.map(o => ({ value:o, label:tr(ESTADO,o) }))], style:{ minWidth:170 } }),
        e(Select, { label:'Criticidade', value:filterCrit, onChange:v=>{ setFilterCrit(v); setAPage(1); }, options:[{value:'all',label:'Todas as criticidades'}, ...CRITICALITY_OPTS.map(o => ({ value:o, label:o }))], style:{ minWidth:170 } }),
        e('span', { style:{ fontSize:'.78rem', color:'#64748b', alignSelf:'end', paddingBottom:4 } }, filtered.length+' ativos')
      ),
      e(Feedback, { msg: feedback }),
      e('table', null,
        e('thead', null, e('tr', null,
          e(SortTh, { label:'Ativo', sortKey:'name', sort, onSort:toggleSort }),
          e(SortTh, { label:'IP', sortKey:'primary_ip', sort, onSort:toggleSort }),
          e(SortTh, { label:'Fabricante / OS', sortKey:'vendor_os', sort, onSort:toggleSort }),
          e(SortTh, { label:'Estado', sortKey:'lifecycle_state', sort, onSort:toggleSort }),
          e(SortTh, { label:'Criticidade', sortKey:'criticality', sort, onSort:toggleSort }),
          e('th',null,'')
        )),
        e('tbody', null,
          aItems.length === 0 ? e('tr', null, e('td', { colSpan:6, style:{textAlign:'center',color:'#8b949e',padding:'2rem'} }, 'Nenhum ativo encontrado.')) : null,
          aItems.map(a => {
            const isEditing = editing && editing.id === a.id;
            return e('tr', { key:a.id },
              e('td', null, a.display_name||a.asset_name),
              e('td', null, a.primary_ip||'—'),
              e('td', null, [a.vendor&&a.vendor!=='Unknown'?a.vendor:null, a.os_hint].filter(Boolean).join(' / ')||'—'),
              e('td', null, isEditing
                ? e('select', { value:editing.form.lifecycle_state||a.lifecycle_state, 'aria-label':'Estado do ativo', onChange:ev=>setEditing({...editing,form:{...editing.form,lifecycle_state:ev.target.value}}),
                    style:{ background:'#0d1117', border:'1px solid #30363d', borderRadius:5, color:'#c9d1d9', padding:'3px 6px', fontSize:'.8rem' }
                  }, LIFECYCLE_OPTS.map(o => e('option',{key:o,value:o},tr(ESTADO,o))))
                : estadoBadge(a.lifecycle_state)
              ),
              e('td', null, isEditing
                ? e('select', { value:editing.form.criticality||a.criticality, 'aria-label':'Criticidade do ativo', onChange:ev=>setEditing({...editing,form:{...editing.form,criticality:ev.target.value}}),
                    style:{ background:'#0d1117', border:'1px solid #30363d', borderRadius:5, color:'#c9d1d9', padding:'3px 6px', fontSize:'.8rem' }
                  }, CRITICALITY_OPTS.map(o => e('option',{key:o,value:o},o)))
                : e('span', { style:{color:'#8b949e',fontSize:'.82rem'} }, a.criticality||'—')
              ),
              e('td', null,
                isEditing
                  ? e('div', { style:{display:'flex',gap:6} },
                      e(BtnPrimary, { onClick:saveEdit }, 'Salvar'),
                      e(BtnSecondary, { onClick:()=>setEditing(null) }, 'Cancelar')
                    )
                  : e(BtnSecondary, { onClick:()=>setEditing({ id:a.id, form:{ lifecycle_state:a.lifecycle_state, criticality:a.criticality } }) }, 'Editar')
              )
            );
          })
        )
      ),
      e(Pager, { page:aPage, total:aTotal, count:filtered.length, setPage:setAPage, pageSize, setPageSize })
    );
  }

  // ── Aba: Topologia ──────────────────────────────────────────────────────────
  function TopologyTab({ data, scope }) {
    const { assets=[], topology=[] } = data;
    const svgRef = React.useRef(null);
    const [modal, setModal] = React.useState(null);
    const [zoomLevel, setZoomLevel] = React.useState(100);
    const zoomRef = React.useRef(null);

    // Build graph data: nodes from assets + external refs, links from topology edges
    const graph = React.useMemo(() => {
      const assetMap = {};
      for (const a of assets) assetMap[a.id] = a;

      const nodes = [];
      const nodeIds = new Set();
      const links = [];

      for (const a of assets) {
        if (!nodeIds.has(a.id)) {
          nodes.push({
            id: a.id,
            label: a.display_name || a.asset_name || a.id,
            ip: a.primary_ip || '',
            type: 'asset',
            vendor: a.vendor,
            product: a.product,
            os_hint: a.os_hint,
            lifecycle_state: a.lifecycle_state,
          });
          nodeIds.add(a.id);
        }
      }

      for (const edge of topology) {
        const targetId = edge.to_asset_ref || '';
        if (!targetId) continue;
        if (!assetMap[targetId] && !nodeIds.has(targetId)) {
          nodes.push({
            id: targetId, label: targetId, ip: '', type: 'external', edgeType: edge.edge_type || '',
          });
          nodeIds.add(targetId);
        }
        links.push({ source: edge.from_asset_id, target: targetId, type: edge.edge_type || 'connected_to' });
      }

      return { nodes, links, assetMap };
    }, [assets, topology]);

    // D3 force simulation with zoom/pan support
    React.useEffect(() => {
      if (!svgRef.current || graph.nodes.length === 0) return;
      const svg = d3.select(svgRef.current);
      const W = 1000, H = 760;

      svg.selectAll('*').remove();

      const edgeColors = {
        host_service: '#3b82f6', service_dependency: '#f97316', service_database: '#ef4444',
        default_gateway: '#eab308', depends_on: '#8b5cf6', dns_resolver: '#22c55e',
        connected_to: '#64748b', runs_on: '#ec4899',
      };
      const edgeLabels = {
        host_service: 'Serviço', service_dependency: 'Dependência', service_database: 'Database',
        default_gateway: 'Gateway', depends_on: 'Depende', dns_resolver: 'DNS',
        connected_to: 'Conectado', runs_on: 'Roda em',
      };
      const edgeColor = t => edgeColors[t] || '#64748b';
      const edgeLabel = t => edgeLabels[t] || t.replace(/_/g, ' ');

      // Nodes with random start positions
      const simNodes = graph.nodes.map(n => ({
        ...n, x: W/2 + (Math.random()-0.5)*200, y: H/2 + (Math.random()-0.5)*200,
      }));
      const nodeMap = {};
      simNodes.forEach(n => { nodeMap[n.id] = n; });

      const simLinks = graph.links
        .map(l => ({ ...l, source: nodeMap[l.source], target: nodeMap[l.target] }))
        .filter(l => l.source && l.target);

      if (simLinks.length === 0 || simNodes.length === 0) return;

      const N = simNodes.length;
      const sim = d3.forceSimulation(simNodes)
        .force('link', d3.forceLink(simLinks).id(d => d.id).distance(N > 200 ? 80 : N > 100 ? 100 : 140))
        .force('charge', d3.forceManyBody().strength(N > 200 ? -200 : N > 100 ? -300 : -500))
        .force('center', d3.forceCenter(W/2, H/2))
        .force('x', d3.forceX(W/2).strength(0.03))
        .force('y', d3.forceY(H/2).strength(0.03))
        .force('collision', d3.forceCollide(N > 200 ? 28 : N > 100 ? 32 : 40));

      // Zoom behavior
      const zoom = d3.zoom()
        .scaleExtent([0.15, 5])
        .on('zoom', (ev) => {
          g.attr('transform', ev.transform);
          setZoomLevel(Math.round(ev.transform.k * 100));
        });
      svg.call(zoom);
      zoomRef.current = zoom;

      // Root group for zoom transforms
      const g = svg.append('g');

      // Arrow marker
      svg.append('defs').append('marker')
        .attr('id', 'arrow').attr('viewBox', '0 0 10 10')
        .attr('refX', 24).attr('refY', 5).attr('markerWidth', 7).attr('markerHeight', 7)
        .attr('orient', 'auto')
        .append('path').attr('d', 'M 0 0 L 10 5 L 0 10 z').attr('fill', '#475569');

      // Links
      const linkLines = g.selectAll('line')
        .data(simLinks).join('line')
        .attr('stroke', d => edgeColor(d.type))
        .attr('stroke-width', 1.5).attr('stroke-opacity', 0.4)
        .attr('marker-end', 'url(#arrow)');

      // Link labels (small graphs only)
      let linkLabels = null;
      if (simLinks.length <= 40) {
        linkLabels = g.selectAll('text.linklabel')
          .data(simLinks).join('text')
          .attr('class', 'linklabel')
          .attr('fill', '#475569').attr('font-size', 8).attr('text-anchor', 'middle').attr('dy', -7)
          .text(d => edgeLabel(d.type));
      }

      // Node groups
      const nodeG = g.selectAll('g.node')
        .data(simNodes).join('g')
        .attr('class', 'node')
        .attr('cursor', d => d.type === 'asset' ? 'pointer' : 'default');

      nodeG.each(function(d) {
        const el = d3.select(this);
        const isAsset = d.type === 'asset';
        const r = isAsset ? 16 : 8;
        el.append('circle')
          .attr('r', r)
          .attr('fill', isAsset ? '#1e293b' : '#334155')
          .attr('stroke', isAsset ? '#3b82f6' : '#eab308')
          .attr('stroke-width', isAsset ? 2 : 1.2)
          .attr('stroke-opacity', isAsset ? 1 : 0.7);
        el.append('text')
          .attr('fill', isAsset ? '#e2e8f0' : '#94a3b8')
          .attr('font-size', isAsset ? 9 : 7).attr('text-anchor', 'middle').attr('dy', r + 12)
          .text(d.label.length > 20 ? d.label.substring(0, 18) + '..' : d.label);
        if (isAsset && d.ip) {
          el.append('text')
            .attr('fill', '#64748b').attr('font-size', 7).attr('text-anchor', 'middle').attr('dy', r + 23)
            .text(d.ip);
        }
        if (isAsset) {
          el.on('click', (ev) => {
            ev.stopPropagation();
            setModal(d);
          });
        }
      });

      // Tick with boundary clamping
      const margin = 40;
      sim.on('tick', () => {
        simNodes.forEach(n => {
          const r = n.type === 'asset' ? 16 : 8;
          n.x = Math.max(margin + r, Math.min(W - margin - r, n.x));
          n.y = Math.max(margin + r, Math.min(H - margin - r, n.y));
        });
        linkLines
          .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        if (linkLabels) {
          linkLabels
            .attr('x', d => (d.source.x + d.target.x) / 2)
            .attr('y', d => (d.source.y + d.target.y) / 2);
        }
        nodeG.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
      });

      return () => sim.stop();
    }, [graph]);

    // Zoom controls
    const zoomIn = () => { if (zoomRef.current) { const svg = d3.select(svgRef.current); svg.transition().duration(300).call(zoomRef.current.scaleBy, 1.4); } };
    const zoomOut = () => { if (zoomRef.current) { const svg = d3.select(svgRef.current); svg.transition().duration(300).call(zoomRef.current.scaleBy, 0.7); } };
    const zoomReset = () => { if (zoomRef.current) { const svg = d3.select(svgRef.current); svg.transition().duration(500).call(zoomRef.current.transform, d3.zoomIdentity); } };

    // Legend
    const legendColors = {
      host_service: '#3b82f6', service_dependency: '#f97316', service_database: '#ef4444',
      default_gateway: '#eab308', depends_on: '#8b5cf6', dns_resolver: '#22c55e',
      connected_to: '#64748b', runs_on: '#ec4899',
    };
    const legendLabels = {
      host_service: 'Serviço', service_dependency: 'Dependência', service_database: 'Database',
      default_gateway: 'Gateway', depends_on: 'Depende', dns_resolver: 'DNS',
      connected_to: 'Conectado', runs_on: 'Roda em',
    };
    const usedTypes = new Set(graph.links.map(l => l.type));
    const legendEntries = [...usedTypes].filter(t => legendLabels[t]);

    // Modal
    const modalEl = modal ? e('div', {
      style:{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 },
      onClick: () => setModal(null)
    },
      e('div', {
        style:{ background:'#1c2128', border:'1px solid #30363d', borderRadius:12, padding:'2rem', maxWidth:'500px', width:'90%', maxHeight:'80vh', overflow:'auto' },
        onClick: ev => ev.stopPropagation()
      },
        e('div', { style:{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem' } },
          e('h3', { style:{ margin:0, fontSize:'1.1rem', color:'#e2e8f0' } }, modal.label),
          e('button', {
            onClick: () => setModal(null),
            style:{ background:'transparent', border:'1px solid #30363d', borderRadius:6, color:'#8b949e', cursor:'pointer', padding:'4px 10px', fontSize:'.9rem' }
          }, '✕')
        ),
        e('div', { style:{ display:'flex', flexDirection:'column', gap:8, fontSize:'.85rem' } },
          e('div', { style:{ display:'flex', justifyContent:'space-between' } },
            e('span', { style:{ color:'#8b949e' } }, 'IP'),
            e('code', { style:{ color:'#58a6ff' } }, modal.ip || '—')
          ),
          modal.vendor ? e('div', { style:{ display:'flex', justifyContent:'space-between' } },
            e('span', { style:{ color:'#8b949e' } }, 'Fabricante'),
            e('span', null, modal.vendor)
          ) : null,
          modal.product ? e('div', { style:{ display:'flex', justifyContent:'space-between' } },
            e('span', { style:{ color:'#8b949e' } }, 'Produto'),
            e('span', null, modal.product)
          ) : null,
          modal.os_hint ? e('div', { style:{ display:'flex', justifyContent:'space-between' } },
            e('span', { style:{ color:'#8b949e' } }, 'SO'),
            e('span', null, modal.os_hint)
          ) : null,
          e('div', { style:{ display:'flex', justifyContent:'space-between' } },
            e('span', { style:{ color:'#8b949e' } }, 'Estado'),
            e('span', { className:'badge badge-'+modal.lifecycle_state }, modal.lifecycle_state||'descoberto')
          )
        ),
        e('div', { style:{ display:'flex', gap:8, marginTop:'1.2rem' } },
          e('a', { href:'/observe/assets/'+modal.id, target:'_blank',
            style:{ background:'#CC1212', color:'#fff', padding:'6px 16px', borderRadius:6, textDecoration:'none', fontSize:'.82rem', fontWeight:600 }
          }, 'Abrir página completa'),
          e('button', {
            onClick: () => setModal(null),
            style:{ background:'transparent', border:'1px solid #30363d', borderRadius:6, color:'#8b949e', cursor:'pointer', padding:'6px 16px', fontSize:'.82rem' }
          }, 'Fechar')
        )
      )
    ) : null;

    if (graph.nodes.length === 0) {
      return e('div', null,
        e('h2', { style:{ fontSize:'1.1rem', margin:'0 0 12px' } }, 'Topologia Operacional'),
        e('p', { style:{ color:'#8b949e', padding:'2.5rem', textAlign:'center', background:'#1c2128', border:'1px solid #30363d', borderRadius:10 } },
          'Nenhum dado de topologia disponível. Execute uma varredura para descobrir relações entre ativos.'
        )
      );
    }

    return e('div', null,
      e('div', { style:{ display:'flex', alignItems:'center', gap:8, marginBottom:6, flexWrap:'wrap' } },
        e('h2', { style:{ fontSize:'1.1rem', margin:0, flex:1 } }, 'Topologia Operacional'),
        e('span', { style:{ fontSize:'.78rem', color:'#64748b' } }, graph.nodes.length + ' nós  ·  ' + graph.links.length + ' arestas'),
        e('span', { style:{ fontSize:'.72rem', color:'#475569', marginLeft:4 } }, '|  ' + zoomLevel + '%'),
        e('button', { onClick: zoomIn, title:'Zoom +',
          style:{ background:'#1e293b', border:'1px solid #30363d', borderRadius:5, color:'#e2e8f0', cursor:'pointer', padding:'3px 8px', fontSize:'.85rem', fontWeight:'bold' }
        }, '+'),
        e('button', { onClick: zoomOut, title:'Zoom -',
          style:{ background:'#1e293b', border:'1px solid #30363d', borderRadius:5, color:'#e2e8f0', cursor:'pointer', padding:'3px 8px', fontSize:'.85rem', fontWeight:'bold' }
        }, '−'),
        e('button', { onClick: zoomReset, title:'Reset zoom',
          style:{ background:'#1e293b', border:'1px solid #30363d', borderRadius:5, color:'#8b949e', cursor:'pointer', padding:'3px 8px', fontSize:'.75rem' }
        }, '↺')
      ),
      legendEntries.length > 0 ? e('div', { style:{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:6, padding:'2px 0' } },
        ...legendEntries.map(t =>
          e('div', { key:t, style:{ display:'flex', alignItems:'center', gap:5, fontSize:'.72rem', color:'#8b949e' } },
            e('span', { style:{ width:18, height:3, background:legendColors[t]||'#64748b', borderRadius:2, display:'inline-block' } }), legendLabels[t] || t))
      ) : null,
      e('div', { style:{ background:'#0d1117', border:'1px solid #30363d', borderRadius:10, overflow:'hidden', position:'relative' } },
        e('svg', {
          ref: svgRef,
          style:{ width:'100%', height:'760px', display:'block', cursor:'grab' },
          viewBox: '0 0 1000 760',
          preserveAspectRatio: 'xMidYMid meet'
        })
      ),
      e('div', { style:{ fontSize:'.7rem', color:'#475569', marginTop:6, textAlign:'center' } },
        'Scroll para zoom  ·  Arraste para mover  ·  Clique nos nós azuis para detalhes  ·  ' +
        (graph.links.length > 40 ? 'Labels ocultos (+40 arestas)' : graph.links.length + ' arestas visíveis')
      ),
      modalEl
    );
  }

  // ── App principal ────────────────────────────────────────────────────────────
  function App() {
    const [tab, setTab] = React.useState('discovery');
    const [data, setData] = React.useState({ assets:[], runs:[], findings:[], fingerprints:[], topology:[], policies:[], targets:[], services:[] });
    const [scopeOptions, setScopeOptions] = React.useState({ tenants:[], sites:[], edges:[] });
    const [scope, setScope] = React.useState({ tenant:'default', site:'default-site', edge:'central' });
    const [scanning, setScanning] = React.useState(false);
    const [scanMsg, setScanMsg] = React.useState(null);
    const [progress, setProgress] = React.useState(null);
    const pollRef = React.useRef(null);

    React.useEffect(() => { _feedbackSet = setScanMsg; }, []);

    async function load() {
      const q = '?tenant_id='+encodeURIComponent(scope.tenant)+'&site_id='+encodeURIComponent(scope.site)+'&edge_id='+encodeURIComponent(scope.edge);
      try {
        const [s, scopeSets] = await Promise.all([
          fetch('/observe/discovery/data/summary'+q).then(x=>x.json()),
          fetch('/observe/discovery/data/scopes').then(x=>x.json()),
        ]);
        setData({ assets:s.assets||[], runs:s.runs||[], findings:s.findings||[], fingerprints:s.fingerprints||[], topology:s.topology||[], policies:s.policies||[], targets:s.targets||[], services:s.services||[] });
        setScopeOptions({
          tenants: Array.isArray(scopeSets.tenants) ? scopeSets.tenants : [],
          sites: Array.isArray(scopeSets.sites) ? scopeSets.sites : [],
          edges: Array.isArray(scopeSets.edges) ? scopeSets.edges : [],
        });
      } catch(err) { showFeedback('Falha ao carregar dados: '+(err.message||'erro de rede')); }
    }

    async function pollProgress() {
      try {
        const r = await fetch(API+'/progress');
        if (!r.ok) return;
        const p = await r.json();
        setProgress(p.active===false && !p.summary ? null : p);
        if (p.stage === 'done' || !p.active) {
          clearInterval(pollRef.current); pollRef.current = null;
          setScanning(false); setTimeout(load, 800);
        }
      } catch(_) {}
    }

    async function scanNow() {
      if (scanning) return;
      setScanning(true); setProgress(null); setScanMsg(null);
      try {
        const r = await fetch(API+'/scan', { method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ profile:'safe', trigger:'ui', tenant_id:scope.tenant, site_id:scope.site, edge_id:scope.edge })
        });
        if (!r.ok) {
          const d = await r.json().catch(()=>({}));
          setScanMsg({ text:'Falha: '+(d.error||'HTTP '+r.status), type:'err' });
          setScanning(false); return;
        }
        if (!pollRef.current) pollRef.current = setInterval(pollProgress, 2000);
        pollProgress();
      } catch(err) {
        setScanMsg({ text:'Erro de comunicação com o serviço.', type:'err' });
        setScanning(false);
      }
    }

    React.useEffect(() => {
      load(); pollProgress();
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [scope.tenant, scope.site, scope.edge]);

    const TABS = [
      { id:'discovery', label:'Descoberta' },
      { id:'policies',  label:'Políticas' },
      { id:'targets',   label:'Targets' },
      { id:'assets',    label:'Ativos' },
      { id:'services',  label:'Serviços' },
      { id:'topology',  label:'Topologia' },
    ];

    return e('div', { className:'wrap' },
      e('div', { style:{ display:'flex', gap:0, borderBottom:'1px solid #30363d', marginBottom:16, flexWrap:'wrap' } },
        TABS.map(t => e('button', { key:t.id,
          onClick:()=>setTab(t.id),
          style:{
            background:'transparent', border:'none', borderBottom: tab===t.id?'2px solid #CC1212':'2px solid transparent',
            color: tab===t.id?'#c9d1d9':'#8b949e', padding:'.6rem 1.1rem', cursor:'pointer',
            fontSize:'.85rem', fontWeight: tab===t.id?600:400, fontFamily:'inherit'
          }
        }, t.label))
      ),
      tab === 'discovery' ? e(DiscoveryTab, { data, scanning, progress, scanMsg, onScan:scanNow, scope, setScope, scopeOptions }) : null,
      tab === 'policies'  ? e(PoliciesTab,  { data, scope, reload:load }) : null,
      tab === 'targets'   ? e(TargetsTab,   { data, scope, reload:load }) : null,
      tab === 'assets'    ? e(AssetsTab,    { data, scope, reload:load }) : null,
      tab === 'services' ? e(ServicesTab, { data, scope, reload:load }) : null,
      tab === 'topology' ? e(TopologyTab, { data, scope }) : null
    );
  }

  ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(App));
  </script>
</body>
</html>`;
