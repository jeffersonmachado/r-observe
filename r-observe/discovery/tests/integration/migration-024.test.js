'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration 024 scopes config backups and SNMP cache by edge', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../migrations/024_discovery_edge_scope.sql'), 'utf8');
  assert.match(sql, /observe_config_backups[\s\S]*ADD COLUMN IF NOT EXISTS edge_id/);
  assert.match(sql, /tenant_id, site_id, edge_id, host, collected_at/);
  assert.match(sql, /observe_snmp_metrics_cache[\s\S]*ADD COLUMN IF NOT EXISTS edge_id/);
  assert.match(sql, /tenant_id, site_id, edge_id, host/);
});
