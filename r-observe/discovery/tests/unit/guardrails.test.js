'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTarget, normalizePolicy } = require('../../src/security/guardrails');

test('bloqueia ranges proibidos default', () => {
  const policy = normalizePolicy({ scan_profile: 'safe', allowed_ranges: ['10.0.0.0/8'] });
  const result = validateTarget({ address: '127.0.0.1' }, policy);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked_range');
});

test('bloqueia fora da allowlist', () => {
  const policy = normalizePolicy({ scan_profile: 'safe', allowed_ranges: ['10.10.0.0/16'] });
  const result = validateTarget({ address: '192.168.1.10' }, policy);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outside_allowlist');
});
