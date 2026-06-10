'use strict';

async function emitEvent(redis, type, payload) {
  if (!redis) return;
  const evt = JSON.stringify({ type, ts: new Date().toISOString(), ...payload });
  await redis.rpush('observe:events', evt);
  await redis.incr('observe:events:published:total');
  await redis.publish(type, evt);
}

module.exports = { emitEvent };
