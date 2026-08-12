'use strict';

// Scheduler de Scans Automaticos para R-Observe Discovery (Enterprise).
// Le schedules da tabela observe_discovery_schedules e dispara scans
// quando next_run_at <= NOW(). Usa cron-expression simplificada.
// Integracao: chamado no startup do discovery e executado em loop via setInterval.

const { log } = require('../utils/logger');
const { runWithTenant } = require('../shared/tenant-context');
const { createQueueJob } = require('../queues/reliable-list');
const { acquireScanAdmission, releaseScanAdmission } = require('../queues/scan-admission');

const SCAN_QUEUE_KEY = 'observe:scan:network';
const CHECK_INTERVAL_MS = 60000;
const LOCK_TTL_MS = 90000;

async function acquireScheduleLock(redis, scheduleId) {
  const key = `observe:discovery:schedule-lock:${scheduleId}`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') return null;
  return async () => {
    await redis.eval(
      "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1, key, token
    ).catch(() => {});
  };
}

// Parse simplificado de cron expression (5 campos: min hora dia mes dia-semana).
// Suporta *, valores fixos, * /N (step).
// Retorna true se a data atual corresponde a expressao.
function cronMatches(expr, date = new Date()) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];

  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(parts[i], values[i])) return false;
  }
  return true;
}

function fieldMatches(field, value) {
  if (field === '*') return true;

  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    return value % parseInt(stepMatch[1], 10) === 0;
  }

  if (field.includes(',')) {
    return field.split(',').some(f => fieldMatches(f.trim(), value));
  }

  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const min = parseInt(rangeMatch[1], 10);
    const max = parseInt(rangeMatch[2], 10);
    return value >= min && value <= max;
  }

  return parseInt(field, 10) === value;
}

// Calcula o proximo next_run_at baseado na cron expression.
// Avanca de minuto em minuto ate encontrar match (max 366 dias).
function calcNextRun(expr, from = new Date()) {
  const maxIterations = 366 * 24 * 60;
  const next = new Date(from.getTime() + 60000);
  next.setSeconds(0, 0);

  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(expr, next)) return next;
    next.setMinutes(next.getMinutes() + 1);
  }
  return null;
}

// Verifica e dispara schedules pendentes.
async function tickTenant({ db, redis, tenantId }) {
  return runWithTenant(tenantId, async () => {
  try {
    const now = new Date();
    const r = await db.query(
      `SELECT * FROM observe_discovery_schedules
       WHERE enabled = true
         AND (next_run_at IS NULL OR next_run_at <= $1)
       ORDER BY next_run_at ASC NULLS FIRST
       LIMIT 10`,
      [now.toISOString()]
    );

    for (const schedule of r.rows) {
      const releaseLock = await acquireScheduleLock(redis, schedule.id);
      if (!releaseLock) continue;
      try {
      const shouldRun = cronMatches(schedule.cron_expression, now);

      if (!shouldRun && schedule.next_run_at && new Date(schedule.next_run_at) <= now) {
        const next = calcNextRun(schedule.cron_expression, now);
        await db.query(
          `UPDATE observe_discovery_schedules SET next_run_at = $2, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $3 AND site_id = $4 AND edge_id = $5`,
          [schedule.id, next ? next.toISOString() : null, schedule.tenant_id, schedule.site_id, schedule.edge_id]
        );
        continue;
      }

      if (!shouldRun) continue;

      const quotaResult = await db.query(
        `SELECT max_concurrent_scans FROM observe_tenant_quotas WHERE tenant_id = $1`,
        [schedule.tenant_id]
      );
      const admission = await acquireScanAdmission(
        redis,
        schedule,
        quotaResult.rows[0]?.max_concurrent_scans || 1
      );
      if (!admission) {
        const deferredNext = calcNextRun(schedule.cron_expression, now);
        await db.query(
          `UPDATE observe_discovery_schedules
           SET next_run_at = $2, last_run_status = 'deferred_concurrency', updated_at = NOW()
           WHERE id = $1 AND tenant_id = $3 AND site_id = $4 AND edge_id = $5`,
          [schedule.id, deferredNext ? deferredNext.toISOString() : null,
            schedule.tenant_id, schedule.site_id, schedule.edge_id]
        );
        continue;
      }

      const payload = createQueueJob({
        tenant_id: schedule.tenant_id,
        site_id: schedule.site_id,
        edge_id: schedule.edge_id,
        policy_id: schedule.policy_id,
        profile: schedule.profile_override || undefined,
        trigger: 'scheduler:' + schedule.name,
        schedule_id: schedule.id,
        docker_discovery_enabled: process.env.DISCOVERY_DOCKER_ENABLED === 'true',
        queue_admission_key: admission.key,
        queue_admission_token: admission.token,
      });

      try {
        await redis.rpush(SCAN_QUEUE_KEY, JSON.stringify(payload));
        await redis.publish(SCAN_QUEUE_KEY, JSON.stringify({ event: 'scan_enqueued', schedule: schedule.name, ts: now.toISOString() }));
      } catch (error) {
        await releaseScanAdmission(redis, admission).catch(() => {});
        throw error;
      }

      const next = calcNextRun(schedule.cron_expression, now);
      await db.query(
        `UPDATE observe_discovery_schedules
         SET last_run_at = $2, next_run_at = $3, run_count = run_count + 1, last_run_status = 'running', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $4 AND site_id = $5 AND edge_id = $6`,
        [schedule.id, now.toISOString(), next ? next.toISOString() : null,
          schedule.tenant_id, schedule.site_id, schedule.edge_id]
      );

      log('info', 'Scheduled scan triggered', {
        schedule: schedule.name,
        tenant_id: schedule.tenant_id,
        next_run: next ? next.toISOString() : null,
      });
      } finally {
        await releaseLock();
      }
    }
  } catch (e) {
    log('warn', 'Scheduler tenant tick failed', { tenant_id: tenantId, err: e.message });
  }
  });
}

// A tabela de tenants não é submetida a RLS e funciona como diretório seguro.
// Cada consulta de schedules, por sua vez, roda dentro do contexto RLS do tenant.
async function tick({ db, redis }) {
  try {
    const tenants = await db.query(`SELECT id FROM observe_tenants WHERE status = 'active' ORDER BY id`);
    for (const tenant of tenants.rows) {
      await tickTenant({ db, redis, tenantId: tenant.id });
    }
  } catch (e) {
    log('warn', 'Scheduler tick failed', { err: e.message });
  }
}

// Inicializa schedules que nunca rodaram (next_run_at = NULL).
async function bootstrapTenantSchedules(db, tenantId) {
  return runWithTenant(tenantId, async () => {
  try {
    const r = await db.query(
      `SELECT * FROM observe_discovery_schedules WHERE enabled = true AND next_run_at IS NULL`
    );
    const now = new Date();
    for (const s of r.rows) {
      const next = calcNextRun(s.cron_expression, now);
      if (next) {
        await db.query(
          `UPDATE observe_discovery_schedules SET next_run_at = $2, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $3 AND site_id = $4 AND edge_id = $5`,
          [s.id, next.toISOString(), s.tenant_id, s.site_id, s.edge_id]
        );
      }
    }
    if (r.rowCount > 0) {
      log('info', 'Bootstrapped schedule next_run_at', { count: r.rowCount });
    }
  } catch (e) {
    log('warn', 'Schedule tenant bootstrap failed', { tenant_id: tenantId, err: e.message });
  }
  });
}

async function bootstrapSchedules(db) {
  try {
    const tenants = await db.query(`SELECT id FROM observe_tenants WHERE status = 'active' ORDER BY id`);
    for (const tenant of tenants.rows) {
      await bootstrapTenantSchedules(db, tenant.id);
    }
  } catch (e) {
    log('warn', 'Schedule bootstrap failed', { err: e.message });
  }
}

// Inicia o loop do scheduler. Retorna uma funcao stop() para desligamento graceful.
function startScheduler({ db, redis }) {
  if (!redis) {
    log('warn', 'Scheduler disabled: Redis not available');
    return () => {};
  }

  bootstrapSchedules(db);

  const interval = setInterval(() => tick({ db, redis }), CHECK_INTERVAL_MS);
  log('info', 'Scheduler started', { interval_ms: CHECK_INTERVAL_MS });

  return () => {
    clearInterval(interval);
    log('info', 'Scheduler stopped');
  };
}

module.exports = { startScheduler, tick, tickTenant, cronMatches, calcNextRun, bootstrapSchedules, bootstrapTenantSchedules, acquireScheduleLock };
