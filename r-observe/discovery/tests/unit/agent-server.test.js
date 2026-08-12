'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleAgentRegister, handleAgentHeartbeat, handleAgentReport, detectOfflineAgents } = require('../../src/scanners/agents');
const { getTenantId } = require('../../src/shared/tenant-context');

const scope = { tenant_id: 'tenant-a', site_id: 'site-a', edge_id: 'edge-a' };

test('agent registration persists authenticated scope', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
  await handleAgentRegister(db, { agent_id: 'agent-1', hostname: 'host-1' }, scope);
  assert.match(calls[0].sql, /tenant_id, site_id, edge_id/);
  assert.deepEqual(calls[0].params.slice(0, 3), ['tenant-a', 'site-a', 'edge-a']);
});

test('agent heartbeat reports missing scoped agent', async () => {
  const db = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.deepEqual(await handleAgentHeartbeat(db, { agent_id: 'agent-1' }, scope), { heartbeat: false, agent_id: 'agent-1' });
});

test('agent report writes assets and findings in supplied scope', async () => {
  const calls = [];
  let released = false;
  const conn = {
    query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    release: () => { released = true; },
  };
  const db = { connect: async () => conn };
  const result = await handleAgentReport({ db, redis: null, body: {
    agent_id: 'agent-1', scope,
    assets: [{ asset_key: 'ip:10.0.0.1', asset_name: 'host', primary_ip: '10.0.0.1' }],
    findings: [{ type: 'agent_icmp_host', payload: { host: '10.0.0.1' } }],
  } });
  assert.equal(result.accepted_assets, 1);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.deepEqual(calls[1].params.slice(0, 3), ['tenant-a', 'site-a', 'edge-a']);
  assert.deepEqual(calls[2].params.slice(0, 3), ['tenant-a', 'site-a', 'edge-a']);
  assert.equal(calls[3].sql, 'COMMIT');
  assert.equal(released, true);
});

test('offline detection consulta cada tenant e atualiza identidade composta', async () => {
  const contexts = [];
  const updates = [];
  const db = { query: async (sql, params) => {
    if (sql.includes('FROM observe_tenants')) return { rows: [{ id: 'tenant-a' }, { id: 'tenant-b' }] };
    if (sql.includes('FROM observe_discovery_agents')) {
      const tenant = getTenantId();
      contexts.push(tenant);
      return tenant === 'tenant-a' ? { rows: [{ tenant_id: tenant, site_id: 's1', edge_id: 'e1', agent_id: 'same', hostname: 'h' }] } : { rows: [] };
    }
    if (sql.includes('UPDATE observe_discovery_agents')) { updates.push({ sql, params }); return { rowCount: 1, rows: [] }; }
    throw new Error(`query inesperada: ${sql}`);
  } };
  const result = await detectOfflineAgents(db);
  assert.deepEqual(contexts, ['tenant-a', 'tenant-b']);
  assert.match(updates[0].sql, /tenant_id = \$1 AND site_id = \$2 AND edge_id = \$3 AND agent_id = \$4/);
  assert.deepEqual(updates[0].params, ['tenant-a', 's1', 'e1', 'same']);
  assert.equal(result.offline, 1);
});
