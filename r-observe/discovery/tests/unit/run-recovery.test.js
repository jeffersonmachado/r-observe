'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recoveryTimeoutMinutes, reconcileStaleRuns } = require('../../src/run-recovery');
const { getTenantId } = require('../../src/shared/tenant-context');

test('recovery timeout rejeita valores perigosamente curtos', () => {
  assert.equal(recoveryTimeoutMinutes({ DISCOVERY_RUN_STALE_MINUTES: '5' }), 120);
  assert.equal(recoveryTimeoutMinutes({ DISCOVERY_RUN_STALE_MINUTES: '45' }), 45);
});

test('reconciliador percorre tenants sob RLS e agrega runs/schedules recuperados', async () => {
  const contexts = [];
  const db = { query: async (sql, params = []) => {
    if (sql.includes('FROM observe_tenants')) return { rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 };
    contexts.push(getTenantId());
    assert.match(sql, /tenant_id/);
    if (sql.includes('observe_discovery_runs')) return { rows: [], rowCount: params[1] === 'a' ? 1 : 0 };
    if (sql.includes('observe_discovery_schedules')) return { rows: [], rowCount: params[0] === 'b' ? 2 : 0 };
    throw new Error(`query inesperada: ${sql}`);
  } };
  const summary = await reconcileStaleRuns(db, { DISCOVERY_RUN_STALE_MINUTES: '30' });
  assert.deepEqual(contexts, ['a', 'a', 'b', 'b']);
  assert.deepEqual(summary, { timeout_minutes: 30, runs: 1, schedules: 2, tenants: 2 });
});
