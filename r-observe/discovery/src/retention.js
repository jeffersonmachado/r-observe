'use strict';

const { log } = require('./utils/logger');
const metrics = require('./metrics');

const TABLES = [
  { table: 'observe_interface_metrics', column: 'collected_at', daysEnv: 'DISCOVERY_RETENTION_METRICS_DAYS', defaultDays: 30 },
  { table: 'observe_asset_history', column: 'captured_at', daysEnv: 'DISCOVERY_RETENTION_HISTORY_DAYS', defaultDays: 90 },
  { table: 'observe_asset_changes', column: 'changed_at', daysEnv: 'DISCOVERY_RETENTION_CHANGES_DAYS', defaultDays: 180 },
  { table: 'observe_discovery_findings', column: 'observed_at', daysEnv: 'DISCOVERY_RETENTION_FINDINGS_DAYS', defaultDays: 90 },
];

function retentionDays(entry, env = process.env) {
  const value = parseInt(env[entry.daysEnv] || String(entry.defaultDays), 10);
  return Number.isInteger(value) && value >= 1 ? value : entry.defaultDays;
}

async function deleteBatch(db, entry, days, batchSize) {
  const result = await db.query(
    `WITH expired AS (
       SELECT ctid FROM ${entry.table}
       WHERE ${entry.column} < NOW() - ($1::int * INTERVAL '1 day')
       LIMIT $2
     ) DELETE FROM ${entry.table} target USING expired WHERE target.ctid=expired.ctid`,
    [days, batchSize]
  );
  return result.rowCount || 0;
}

async function runRetention(db, env = process.env) {
  const batchSize = Math.max(100, Math.min(50000, parseInt(env.DISCOVERY_RETENTION_BATCH_SIZE || '5000', 10)));
  const summary = {};
  for (const entry of TABLES) {
    const days = retentionDays(entry, env);
    let deleted = 0;
    for (;;) {
      const count = await deleteBatch(db, entry, days, batchSize);
      deleted += count;
      if (count < batchSize) break;
    }
    summary[entry.table] = { deleted, days };
    if (deleted) metrics.retentionDeleted.inc({ table: entry.table }, deleted);
  }
  log('info', 'Discovery retention completed', summary);
  return summary;
}

function startRetention({ db, env = process.env }) {
  if (env.DISCOVERY_RETENTION_ENABLED === 'false') return () => {};
  const intervalMs = Math.max(3600000, parseInt(env.DISCOVERY_RETENTION_INTERVAL_MS || '86400000', 10));
  const timer = setInterval(() => runRetention(db, env).catch((e) => log('warn', 'Discovery retention failed', { err: e.message })), intervalMs);
  timer.unref?.();
  setImmediate(() => runRetention(db, env).catch((e) => log('warn', 'Initial discovery retention failed', { err: e.message })));
  return () => clearInterval(timer);
}

module.exports = { TABLES, retentionDays, runRetention, startRetention };
