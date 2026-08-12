'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TABLES, retentionDays, runRetention } = require('../../src/retention');

test('retention days use safe defaults for invalid values', () => {
  const entry = TABLES.find((item) => item.table === 'observe_asset_history');
  assert.equal(retentionDays(entry, {}), 90);
  assert.equal(retentionDays(entry, { DISCOVERY_RETENTION_HISTORY_DAYS: '7' }), 7);
  assert.equal(retentionDays(entry, { DISCOVERY_RETENTION_HISTORY_DAYS: '0' }), 90);
});

test('retention deletes old records in bounded batches', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 0 }; } };
  const result = await runRetention(db, { DISCOVERY_RETENTION_BATCH_SIZE: '1000' });
  assert.equal(calls.length, TABLES.length);
  assert.ok(calls.every((call) => /LIMIT \$2/.test(call.sql)));
  assert.ok(calls.every((call) => call.params[1] === 1000));
  assert.equal(result.observe_asset_history.days, 90);
});
