'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scopeKey, acquireScanAdmission, releaseScanAdmission, admissionFromJob } = require('../../src/queues/scan-admission');

test('scopeKey separa tenant, site e edge com encoding seguro', () => {
  assert.equal(scopeKey({ tenant_id: 'a:b', site_id: 's/1', edge_id: 'e 1' }), 'a%3Ab:s%2F1:e%201');
});

test('admissão ocupa o primeiro slot livre e respeita o limite', async () => {
  const occupied = new Set();
  const redis = { set: async (key) => {
    if (occupied.has(key)) return null;
    occupied.add(key);
    return 'OK';
  } };
  const scope = { tenant_id: 't', site_id: 's', edge_id: 'e' };
  const first = await acquireScanAdmission(redis, scope, 2);
  const second = await acquireScanAdmission(redis, scope, 2);
  const third = await acquireScanAdmission(redis, scope, 2);
  assert.equal(first.slot, 0);
  assert.equal(second.slot, 1);
  assert.equal(third, null);
});

test('liberação usa comparação owner-safe e job restaura admission', async () => {
  const calls = [];
  const redis = { eval: async (...args) => { calls.push(args); return 1; } };
  const admission = admissionFromJob({ queue_admission_key: 'key', queue_admission_token: 'token' });
  assert.deepEqual(admission, { key: 'key', token: 'token' });
  assert.equal(await releaseScanAdmission(redis, admission), 1);
  assert.deepEqual(calls[0].slice(-3), [1, 'key', 'token']);
});
