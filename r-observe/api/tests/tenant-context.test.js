'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTenantId,
  runWithTenant,
  getTenantId,
} = require('../../shared/tenant-context');

test('contexto de tenant é preservado através de operações assíncronas', async () => {
  await runWithTenant('tenant-a', async () => {
    await Promise.resolve();
    assert.equal(getTenantId(), 'tenant-a');
  });
  assert.equal(getTenantId(), 'default');
});

test('contextos concorrentes não vazam tenant entre requests', async () => {
  const [a, b] = await Promise.all([
    runWithTenant('tenant-a', async () => { await new Promise(resolve => setImmediate(resolve)); return getTenantId(); }),
    runWithTenant('tenant-b', async () => { await Promise.resolve(); return getTenantId(); }),
  ]);
  assert.deepEqual([a, b], ['tenant-a', 'tenant-b']);
});

test('tenant_id inválido é rejeitado antes de chegar ao banco', () => {
  assert.throws(() => normalizeTenantId('../tenant'), { code: 'INVALID_TENANT_ID' });
  assert.throws(() => normalizeTenantId('tenant com espaço'), { code: 'INVALID_TENANT_ID' });
});
