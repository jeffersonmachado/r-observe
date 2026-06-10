'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration 004 contem tabelas discovery obrigatorias', () => {
  const p = path.resolve(__dirname, '../../../migrations/004_discovery_engine.sql');
  const sql = fs.readFileSync(p, 'utf8');
  const tables = [
    'observe_assets',
    'observe_asset_services',
    'observe_discovery_runs',
    'observe_discovery_findings',
    'observe_topology_edges',
    'observe_dependencies',
  ];
  for (const t of tables) {
    assert.ok(sql.includes(t), `tabela ausente na migration: ${t}`);
  }
});
