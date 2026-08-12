'use strict';

const crypto = require('crypto');

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

class RedisRateLimitStore {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.prefix = options.prefix || 'r-observe:rate';
    this.windowMs = Number(options.windowMs || 60_000);
    this.local = new Map();
  }

  init(options) {
    this.windowMs = Number(options.windowMs || this.windowMs);
  }

  redisKey(key) {
    const digest = crypto.createHash('sha256').update(String(key)).digest('hex');
    return `${this.prefix}:${digest}`;
  }

  incrementLocal(key) {
    const now = Date.now();
    let entry = this.local.get(key);
    if (!entry || entry.resetTime.getTime() <= now) {
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
    }
    entry.totalHits += 1;
    this.local.set(key, entry);
    return entry;
  }

  async increment(key) {
    const redisKey = this.redisKey(key);
    if (this.redis?.status === 'ready') {
      try {
        const [hits, ttl] = await this.redis.eval(INCREMENT_SCRIPT, 1, redisKey, this.windowMs);
        return {
          totalHits: Number(hits),
          resetTime: new Date(Date.now() + Math.max(1, Number(ttl))),
        };
      } catch (_) {
        // Disponibilidade controlada: mantém proteção por processo durante a falha.
      }
    }
    return this.incrementLocal(redisKey);
  }

  async decrement(key) {
    const redisKey = this.redisKey(key);
    if (this.redis?.status === 'ready') {
      try {
        await this.redis.eval(
          `local n=tonumber(redis.call('GET',KEYS[1]) or '0'); if n>0 then return redis.call('DECR',KEYS[1]) end; return 0`,
          1, redisKey
        );
        return;
      } catch (_) { /* usa fallback */ }
    }
    const entry = this.local.get(redisKey);
    if (entry?.totalHits > 0) entry.totalHits -= 1;
  }

  async resetKey(key) {
    const redisKey = this.redisKey(key);
    if (this.redis?.status === 'ready') {
      try { await this.redis.del(redisKey); } catch (_) { /* limpa fallback abaixo */ }
    }
    this.local.delete(redisKey);
  }
}

module.exports = { RedisRateLimitStore, INCREMENT_SCRIPT };
