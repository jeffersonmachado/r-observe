'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration 022 deduplicates and constrains logical dependencies', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../migrations/022_discovery_dependency_dedupe.sql'), 'utf8');
  assert.match(sql, /DELETE FROM observe_dependencies/);
  assert.match(sql, /CREATE UNIQUE INDEX/);
  assert.match(sql, /metadata->>'port'/);
});
