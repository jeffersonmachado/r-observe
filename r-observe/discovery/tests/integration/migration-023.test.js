'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration 023 scopes agent identity by tenant, site and edge', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../migrations/023_discovery_agents_tenant.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS tenant_id/);
  assert.match(sql, /tenant_id, site_id, edge_id, agent_id/);
});
