'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPortChanges } = require('../../src/engine/discovery-engine');

const tenant = { tenant_id: 'tenant-a', site_id: 'site-a', edge_id: 'edge-a' };

test('closed port increments persisted missed_scans and alerts after grace', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const previous = [{ service_key: 'tcp:443', service_name: 'https', port: 443, protocol: 'tcp', status: 'closed', fingerprint: { missed_scans: 1 } }];
  const changes = await detectPortChanges(db, tenant, { id: 'asset-1', asset_key: 'ip:10.0.0.1', asset_name: 'host', services: [] }, previous);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'port_closed');
  assert.equal(changes[0].payload.consecutive_misses, 2);
  assert.match(calls[0].sql, /fingerprint=COALESCE/);
  assert.deepEqual(JSON.parse(calls[0].params[5]), { missed_scans: 2 });
});

test('reopened port is reported from the previous closed snapshot', async () => {
  const db = { query: async () => ({ rows: [] }) };
  const previous = [{ service_key: 'tcp:22', service_name: 'ssh', port: 22, protocol: 'tcp', status: 'closed', fingerprint: { missed_scans: 2 } }];
  const changes = await detectPortChanges(db, tenant, { id: 'asset-1', asset_key: 'ip:10.0.0.1', asset_name: 'host', services: [{ port: 22, protocol: 'tcp' }] }, previous);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'port_opened');
});
