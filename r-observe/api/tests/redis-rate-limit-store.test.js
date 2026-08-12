'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { RedisRateLimitStore } = require('../src/auth/redis-rate-limit-store');
const { rateLimit } = require('express-rate-limit');

describe('RedisRateLimitStore', () => {
  it('implementa o contrato aceito pelo express-rate-limit', () => {
    assert.doesNotThrow(() => rateLimit({
      windowMs: 1000,
      limit: 10,
      store: new RedisRateLimitStore(null, { prefix: 'contract' }),
    }));
  });

  it('incrementa atomicamente no Redis e não expõe o identificador na chave', async () => {
    let count = 0;
    const keys = [];
    const redis = {
      status: 'ready',
      async eval(_script, _numberOfKeys, key, windowMs) {
        keys.push(key);
        count += 1;
        return [count, Number(windowMs)];
      },
    };
    const store = new RedisRateLimitStore(redis, { prefix: 'test:api', windowMs: 1000 });
    const results = await Promise.all(Array.from({ length: 20 }, () => store.increment('203.0.113.9')));

    assert.deepEqual(results.map((result) => result.totalHits), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(keys.every((key) => key.startsWith('test:api:')), true);
    assert.equal(keys.some((key) => key.includes('203.0.113.9')), false);
    assert.equal(results.every((result) => result.resetTime instanceof Date), true);
  });

  it('mantém limite local quando Redis não está pronto', async () => {
    const store = new RedisRateLimitStore({ status: 'connecting' }, { windowMs: 60_000 });
    assert.equal((await store.increment('client')).totalHits, 1);
    assert.equal((await store.increment('client')).totalHits, 2);
    await store.decrement('client');
    assert.equal((await store.increment('client')).totalHits, 2);
    await store.resetKey('client');
    assert.equal((await store.increment('client')).totalHits, 1);
  });

  it('cai para memória se o comando Redis falhar', async () => {
    const store = new RedisRateLimitStore({
      status: 'ready',
      async eval() { throw new Error('redis unavailable'); },
    });
    assert.equal((await store.increment('client')).totalHits, 1);
    assert.equal((await store.increment('client')).totalHits, 2);
  });

  it('mantém namespaces independentes', async () => {
    const api = new RedisRateLimitStore(null, { prefix: 'api' });
    const events = new RedisRateLimitStore(null, { prefix: 'events' });
    assert.notEqual(api.redisKey('same-client'), events.redisKey('same-client'));
    assert.equal((await api.increment('same-client')).totalHits, 1);
    assert.equal((await events.increment('same-client')).totalHits, 1);
  });
});
