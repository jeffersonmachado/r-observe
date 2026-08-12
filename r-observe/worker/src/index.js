'use strict';

const express    = require('express');
const Redis      = require('ioredis');
const remediation = require('./remediation');
const icinga      = require('./icinga');
const { createDbClient } = require('./db');
const { createEventProcessor } = require('./services/event-processor');
const { createWhatsAppNotifier } = require('./services/whatsapp-notify');
const { createLifecycle } = require('../shared/lifecycle');
const { runWithTenant } = require('../shared/tenant-context');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '3000', 10);
const LOG_LEVEL      = process.env.LOG_LEVEL || 'info';
const AI_ENABLED     = process.env.AI_ENABLED === 'true';
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://observe-ai:3000';
const QUEUE_KEYS             = ['observe:events', 'observe:events:icinga', 'observe:remediation:execute', 'observe:scan:results'];
const PROACTIVE_INTERVAL_MS  = parseInt(process.env.AI_PROACTIVE_INTERVAL_MS || '300000', 10); // 5 min
const PROACTIVE_STALE_MIN    = parseInt(process.env.AI_PROACTIVE_STALE_MIN   || '10',     10); // sem análise há 10+ min
const REMEDIATION_ENABLED = process.env.REMEDIATION_ENABLED !== 'false';

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, msg, extra = {}) {
  if (level === 'debug' && LOG_LEVEL !== 'debug') return;
  process.stdout.write(JSON.stringify({ level, service: 'r-observe-worker', msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

// ─── DB (Sequelize) ──────────────────────────────────────────────────────
const db = createDbClient(process.env);

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});
redis.on('error', (e) => log('error', 'Redis error', { err: e.message }));

// ─── Event processor (extraído para services/event-processor.js) ────────────
const whatsapp = createWhatsAppNotifier({ db, log });

const processorState = { count: 0 };
const {
  rem,
  processEvent,
  processScanResults,
  dispatchApprovedRemediation,
  proactiveAnalysis,
} = createEventProcessor({
  db,
  remediation,
  icinga,
  whatsapp,
  log,
  config: {
    AI_ENABLED,
    AI_SERVICE_URL,
    REMEDIATION_ENABLED,
    PROACTIVE_STALE_MIN,
  },
});

// ─── Heartbeat state ──────────────────────────────────────────────────────────
let lastProcessedAt = null;
let processedCount  = 0;
let errorCount      = 0;
let running         = false;

// ─── Carrega catálogo dinâmico do banco ───────────────────────────────────────
async function loadCatalogFromDb() {
  try {
    const r = await db.query(
      `SELECT action, description, risk, params, enabled, auto_ok, max_severity
       FROM observe_ai_catalog WHERE enabled = true ORDER BY action`
    );
    remediation.setCatalogMeta(r.rows);
    log('info', 'Catálogo dinâmico carregado', { count: r.rowCount });
  } catch (e) {
    log('warn', 'Falha ao carregar catálogo do DB — usando embutido', { err: e.message });
  }
}

// ─── Poll loop (blpop bloqueante — sem busy-wait) ────────────────────────────
async function pollQueues() {
  const result = await redis.blpop(...QUEUE_KEYS, 1);
  if (!result) return;
  const [key, raw] = result;
  let payload = {};
  try { payload = JSON.parse(raw); } catch (_) { /* processor registra payload inválido */ }
  const tenantId = payload.tenant_id || payload.tenantId || 'default';
  await runWithTenant(tenantId, async () => {
    if (key === 'observe:remediation:execute') {
      await dispatchApprovedRemediation(raw);
    } else if (key === 'observe:scan:results') {
      await processScanResults(raw);
    } else {
      await processEvent(raw);
      lastProcessedAt = new Date().toISOString();
      processedCount++;
    }
  });
}

async function startWorker() {
  await redis.connect();
  await loadCatalogFromDb();
  log('info', 'Worker started, polling queues', { queues: QUEUE_KEYS });
  running = true;

  // Monitoramento proativo — roda a cada PROACTIVE_INTERVAL_MS
  if (AI_ENABLED && PROACTIVE_INTERVAL_MS > 0) {
    setInterval(() => proactiveAnalysis(processorState), PROACTIVE_INTERVAL_MS);
    log('info', 'Proactive AI analysis scheduled', { interval_ms: PROACTIVE_INTERVAL_MS });
  }

  const loop = async () => {
    if (!running) return;
    try {
      await pollQueues();
    } catch (e) {
      errorCount++;
      log('error', 'Queue poll error', { err: e.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
    setImmediate(loop);
  };
  loop();
}

// ─── HTTP server (health + metrics) ──────────────────────────────────────────
const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'r-observe-worker', version: '0.1.0', running, processedCount, errorCount, lastProcessedAt });
});

app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain');
  res.end([
    `# HELP r_observe_worker_events_processed_total Total events processed`,
    `# TYPE r_observe_worker_events_processed_total counter`,
    `r_observe_worker_events_processed_total ${processedCount}`,
    `# HELP r_observe_worker_errors_total Total processing errors`,
    `# TYPE r_observe_worker_errors_total counter`,
    `r_observe_worker_errors_total ${errorCount}`,
    `# HELP r_observe_remediations_total Total remediations by outcome`,
    `# TYPE r_observe_remediations_total counter`,
    `r_observe_remediations_total{outcome="auto_executed"} ${rem.auto}`,
    `r_observe_remediations_total{outcome="pending_approval"} ${rem.pending}`,
    `r_observe_remediations_total{outcome="approved_by_human"} ${rem.approved}`,
    `r_observe_remediations_total{outcome="execution_success"} ${rem.success}`,
    `r_observe_remediations_total{outcome="execution_failed"}  ${rem.failed}`,
    `# HELP r_observe_queue_depth Current queue depth`,
    `# TYPE r_observe_queue_depth gauge`,
    `r_observe_queue_depth{queue="events"} 0`,
    `r_observe_queue_depth{queue="icinga_events"} 0`,
    `r_observe_queue_depth{queue="remediation"} 0`,
    `r_observe_queue_depth{queue="scan_results"} 0`,
  ].join('\n') + '\n');
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', `HTTP server on :${PORT}`);
  startWorker().catch((e) => {
    log('error', 'Worker failed to start', { err: e.message });
    process.exit(1);
  });
});

const lifecycle = createLifecycle({ label: 'r-observe-worker', log });
lifecycle.onServer(server);
lifecycle.addCloser('worker-loop', () => { running = false; return Promise.resolve(); });
lifecycle.addCloser('db', () => db.end());
lifecycle.addCloser('redis', () => redis.quit());
lifecycle.start();
