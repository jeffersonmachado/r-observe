'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCrossTenantScope, resolveTenantId, parseScope } = require('../../src/auth/tenant-scope');

test('tenant autenticado prevalece sobre tenant controlado pelo cliente', () => {
  const auth = { tenantId: 'tenant-a', scope: 'discovery:read' };
  assert.equal(resolveTenantId(auth, 'tenant-b'), 'tenant-a');
  assert.equal(parseScope({ tenant_id: 'tenant-b' }, auth).tenant_id, 'tenant-a');
});

test('tenant:all permite seleção cross-tenant explícita para M2M', () => {
  const auth = { tenantId: 'operations', scope: ['discovery:read', 'tenant:all'] };
  assert.equal(hasCrossTenantScope(auth), true);
  assert.equal(resolveTenantId(auth, 'tenant-b'), 'tenant-b');
});

test('ausência de tenant no token é fail-safe para default', () => {
  assert.deepEqual(parseScope({}, {}), {
    tenant_id: 'default',
    site_id: 'default-site',
    edge_id: 'central',
  });
});

test('escopo interno preserva tenant previamente autenticado e normalizado', () => {
  assert.deepEqual(parseScope({ tenant_id: 'tenant-internal', site_id: 'site-a', edge_id: 'edge-a' }), {
    tenant_id: 'tenant-internal',
    site_id: 'site-a',
    edge_id: 'edge-a',
  });
});
