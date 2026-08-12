'use strict';

/**
 * R-Observe API — Periodic Metrics Updater
 *
 * Atualiza gauges Prometheus periodicamente:
 *   - r_observe_active_incidents: incidentes não resolvidos
 *   - r_observe_active_sessions: sessões ativas
 */

const UPDATE_INTERVAL_MS = 60000; // 1 minuto

function createMetricsUpdater({ db, activeIncidentsGauge, activeSessionsGauge, log }) {
  async function update() {
    try {
      // Active incidents
      const incResult = await db.query(
        `SELECT COUNT(*) as count FROM observe_incidents WHERE status NOT IN ('resolved', 'closed')`
      ).catch(() => ({ rows: [{ count: 0 }] }));
      activeIncidentsGauge.set(parseInt(incResult.rows[0]?.count || 0));

      // Active sessions
      const sessResult = await db.query(
        `SELECT COUNT(*) as count FROM observe_sessions WHERE expires_at > NOW()`
      ).catch(() => ({ rows: [{ count: 0 }] }));
      activeSessionsGauge.set(parseInt(sessResult.rows[0]?.count || 0));
    } catch (e) {
      log?.('debug', 'Metrics update skipped', { err: e.message });
    }
  }

  function start() {
    update(); // initial update
    const timer = setInterval(update, UPDATE_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  return { update, start };
}

module.exports = { createMetricsUpdater };
