'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../../migrations/018_multi_tenancy.sql'), 'utf8');

test('migration multi-tenant cria colunas core antes dos índices', () => {
  const addColumn = migration.indexOf('ALTER TABLE observe_incidents');
  const createIndex = migration.indexOf('idx_observe_incidents_tenant');
  assert.ok(addColumn >= 0 && createIndex > addColumn);
});

test('migration multi-tenant habilita e força RLS com WITH CHECK', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /WITH CHECK \(tenant_id = current_tenant\(\)\)/);
});
