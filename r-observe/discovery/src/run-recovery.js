'use strict';

const { runWithTenant } = require('./shared/tenant-context');
const { log } = require('./utils/logger');

function recoveryTimeoutMinutes(env = process.env) {
  const value = parseInt(env.DISCOVERY_RUN_STALE_MINUTES || '120', 10);
  return Number.isInteger(value) && value >= 15 ? value : 120;
}

async function reconcileTenant(db, tenantId, timeoutMinutes) {
  return runWithTenant(tenantId, async () => {
    const runs = await db.query(
      `UPDATE observe_discovery_runs
       SET status = 'failed', completed_at = NOW(), updated_at = NOW(),
           summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
             'error', 'worker_interrupted', 'recovered_at', NOW(), 'stale_after_minutes', $1::int
           )
       WHERE tenant_id = $2 AND status IN ('queued','running')
         AND started_at < NOW() - ($1::int * INTERVAL '1 minute')
       RETURNING id`,
      [timeoutMinutes, tenantId]
    );
    const schedules = await db.query(
      `UPDATE observe_discovery_schedules
       SET last_run_status = 'failed', updated_at = NOW()
       WHERE tenant_id = $1 AND last_run_status = 'running'
         AND COALESCE(last_run_at, updated_at) < NOW() - ($2::int * INTERVAL '1 minute')
       RETURNING id`,
      [tenantId, timeoutMinutes]
    );
    return { runs: runs.rowCount || 0, schedules: schedules.rowCount || 0 };
  });
}

async function reconcileStaleRuns(db, env = process.env) {
  const timeoutMinutes = recoveryTimeoutMinutes(env);
  const tenants = await db.query(`SELECT id FROM observe_tenants WHERE status = 'active' ORDER BY id`);
  const summary = { timeout_minutes: timeoutMinutes, runs: 0, schedules: 0, tenants: tenants.rowCount || tenants.rows.length };
  for (const tenant of tenants.rows) {
    const result = await reconcileTenant(db, tenant.id, timeoutMinutes);
    summary.runs += result.runs;
    summary.schedules += result.schedules;
  }
  if (summary.runs || summary.schedules) log('warn', 'Recovered stale discovery state', summary);
  return summary;
}

function startRunRecovery({ db, env = process.env }) {
  if (env.DISCOVERY_RUN_RECOVERY_ENABLED === 'false') return () => {};
  const intervalMs = Math.max(60000, parseInt(env.DISCOVERY_RUN_RECOVERY_INTERVAL_MS || '300000', 10));
  const run = () => reconcileStaleRuns(db, env).catch((e) => log('warn', 'Discovery run recovery failed', { err: e.message }));
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setImmediate(run);
  return () => clearInterval(timer);
}

module.exports = { recoveryTimeoutMinutes, reconcileTenant, reconcileStaleRuns, startRunRecovery };
