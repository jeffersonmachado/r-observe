'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { LoginGuard, identityKey } = require('../src/auth/login-guard');

const req = { ip: '192.0.2.10', socket: {}, headers: {} };

describe('LoginGuard', () => {
  it('bloqueia no limite e libera após login válido usando fallback local', async () => {
    const guard = new LoginGuard(null, { maxAttempts: 3, windowSeconds: 60, lockSeconds: 60 });
    await guard.recordFailure('Admin', req);
    await guard.recordFailure('admin', req);
    assert.equal((await guard.check('ADMIN', req)).blocked, false);
    await guard.recordFailure('admin', req);
    assert.equal((await guard.check('admin', req)).blocked, true);
    await guard.recordSuccess('admin', req);
    assert.equal((await guard.check('admin', req)).blocked, false);
  });

  it('não mistura usuários ou endereços IP', () => {
    assert.notEqual(identityKey('alice', req), identityKey('bob', req));
    assert.notEqual(identityKey('alice', req), identityKey('alice', { ...req, ip: '192.0.2.11' }));
    assert.equal(identityKey(' Alice ', req), identityKey('alice', req));
  });

  it('usa TTL e chaves opacas no Redis quando disponível', async () => {
    const values = new Map();
    const expires = new Map();
    const redis = {
      status: 'ready',
      async incr(key) { const next = Number(values.get(key) || 0) + 1; values.set(key, next); return next; },
      async expire(key, seconds) { expires.set(key, seconds); },
      async set(key, value, _ex, seconds) { values.set(key, value); expires.set(key, seconds); },
      async del(...keys) { keys.forEach((key) => { values.delete(key); expires.delete(key); }); },
      async ttl(key) { return values.has(key) ? expires.get(key) : -2; },
    };
    const guard = new LoginGuard(redis, { maxAttempts: 2, windowSeconds: 30, lockSeconds: 45 });
    await guard.recordFailure('admin', req);
    await guard.recordFailure('admin', req);
    const state = await guard.check('admin', req);
    assert.deepEqual(state, { blocked: true, retryAfterSeconds: 45 });
    assert.equal([...values.keys()].some((key) => key.includes('admin')), false);
  });
});
