'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePolicy } = require('../../src/security/guardrails');
const { resolveProfile } = require('../../src/policies/profiles');

test('perfil safe permanece default e nao agressivo', () => {
  const p = normalizePolicy({ scan_profile: 'safe' });
  const profile = resolveProfile(p.profile);
  assert.equal(profile.allowUdp, false);
  assert.ok(profile.maxConcurrency <= 10);
});
