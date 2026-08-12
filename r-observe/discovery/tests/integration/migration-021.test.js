'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration 021 creates scoped partial unique index for active alerts', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../migrations/021_discovery_alert_dedupe.sql'), 'utf8');
  assert.match(sql, /tenant_id, site_id, edge_id, fingerprint/);
  assert.match(sql, /WHERE resolved_at IS NULL/);
});
