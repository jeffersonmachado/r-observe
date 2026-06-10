'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProfile } = require('../../src/policies/profiles');

test('safe e o profile padrao', () => {
  const p = resolveProfile('nao-existe');
  assert.equal(p.allowUdp, false);
  assert.ok(Array.isArray(p.ports));
});

test('aggressive possui maior concorrencia', () => {
  const safe = resolveProfile('safe');
  const aggr = resolveProfile('aggressive');
  assert.ok(aggr.maxConcurrency > safe.maxConcurrency);
});
