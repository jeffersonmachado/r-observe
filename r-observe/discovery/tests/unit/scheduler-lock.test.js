'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { acquireScheduleLock, tick } = require('../../src/schedulers/scan-scheduler');
const { getTenantId } = require('../../src/shared/tenant-context');

test('schedule lock uses atomic Redis NX and owner-safe release', async () => {
  const calls = [];
  const redis = {
    set: async (...args) => { calls.push(['set', ...args]); return 'OK'; },
    eval: async (...args) => { calls.push(['eval', ...args]); return 1; },
  };
  const release = await acquireScheduleLock(redis, 'schedule-1');
  assert.equal(typeof release, 'function');
  assert.deepEqual(calls[0].slice(-3), ['PX', 90000, 'NX']);
  await release();
  assert.equal(calls[1][0], 'eval');
});

test('schedule lock returns null when another replica owns it', async () => {
  const redis = { set: async () => null };
  assert.equal(await acquireScheduleLock(redis, 'schedule-1'), null);
});

test('scheduler enumera tenants ativos e consulta schedules sob o RLS de cada tenant', async () => {
  const contexts = [];
  const db = {
    query: async (sql) => {
      if (sql.includes('FROM observe_tenants')) return { rows: [{ id: 'acme' }, { id: 'globex' }] };
      if (sql.includes('FROM observe_discovery_schedules')) {
        contexts.push(getTenantId());
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`query inesperada: ${sql}`);
    },
  };
  await tick({ db, redis: {} });
  assert.deepEqual(contexts, ['acme', 'globex']);
});
