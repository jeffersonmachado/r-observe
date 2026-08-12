'use strict';

const crypto = require('crypto');

function identityKey(username, req) {
  const normalized = String(username || '').trim().toLowerCase();
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  return crypto.createHash('sha256').update(`${normalized}\0${ip}`).digest('hex');
}

class LoginGuard {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.maxAttempts = Number(options.maxAttempts || 5);
    this.windowSeconds = Number(options.windowSeconds || 15 * 60);
    this.lockSeconds = Number(options.lockSeconds || 15 * 60);
    this.prefix = options.prefix || 'r-observe:auth:login';
    this.local = new Map();
  }

  keys(username, req) {
    const id = identityKey(username, req);
    return { attempts: `${this.prefix}:attempts:${id}`, lock: `${this.prefix}:lock:${id}` };
  }

  pruneLocal(now = Date.now()) {
    for (const [key, state] of this.local) {
      if (state.expiresAt <= now && state.lockedUntil <= now) this.local.delete(key);
    }
  }

  async check(username, req) {
    const keys = this.keys(username, req);
    if (this.redis?.status === 'ready') {
      const ttl = await this.redis.ttl(keys.lock);
      return { blocked: ttl > 0, retryAfterSeconds: Math.max(0, ttl) };
    }
    this.pruneLocal();
    const state = this.local.get(keys.lock);
    const retry = state ? Math.ceil((state.lockedUntil - Date.now()) / 1000) : 0;
    return { blocked: retry > 0, retryAfterSeconds: Math.max(0, retry) };
  }

  async recordFailure(username, req) {
    const keys = this.keys(username, req);
    if (this.redis?.status === 'ready') {
      const count = await this.redis.incr(keys.attempts);
      if (count === 1) await this.redis.expire(keys.attempts, this.windowSeconds);
      if (count >= this.maxAttempts) {
        await this.redis.set(keys.lock, '1', 'EX', this.lockSeconds);
        await this.redis.del(keys.attempts);
      }
      return;
    }

    const now = Date.now();
    this.pruneLocal(now);
    const state = this.local.get(keys.lock) || { attempts: 0, expiresAt: now + this.windowSeconds * 1000, lockedUntil: 0 };
    if (state.expiresAt <= now) {
      state.attempts = 0;
      state.expiresAt = now + this.windowSeconds * 1000;
    }
    state.attempts += 1;
    if (state.attempts >= this.maxAttempts) {
      state.attempts = 0;
      state.lockedUntil = now + this.lockSeconds * 1000;
    }
    this.local.set(keys.lock, state);
  }

  async recordSuccess(username, req) {
    const keys = this.keys(username, req);
    if (this.redis?.status === 'ready') {
      await this.redis.del(keys.attempts, keys.lock);
    }
    this.local.delete(keys.lock);
  }
}

module.exports = { LoginGuard, identityKey };
