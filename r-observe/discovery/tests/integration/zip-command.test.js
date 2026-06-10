'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package scripts obrigatorios existem para zip/discovery', () => {
  const p = path.resolve(__dirname, '../../../../package.json');
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(pkg.scripts['zip']);
  assert.ok(pkg.scripts['zip:release']);
  assert.ok(pkg.scripts['observe:validate']);
  assert.ok(pkg.scripts['discovery:test']);
});
