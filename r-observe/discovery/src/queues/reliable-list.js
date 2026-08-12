'use strict';

const crypto = require('node:crypto');

const MAIN_QUEUE = 'observe:scan:network';
const PROCESSING_PREFIX = 'observe:scan:network:processing:';
const HEARTBEAT_PREFIX = 'observe:scan:network:consumer:';
const DEAD_LETTER_QUEUE = 'observe:scan:network:dead-letter';
const DONE_PREFIX = 'observe:scan:network:done:';
const MAX_RETRIES = Math.max(0, parseInt(process.env.DISCOVERY_QUEUE_MAX_RETRIES || '3', 10));

function createQueueJob(payload = {}) {
  return {
    ...payload,
    queue_job_id: payload.queue_job_id || crypto.randomUUID(),
    queue_attempt: Number.isInteger(payload.queue_attempt) ? payload.queue_attempt : 0,
    queued_at: payload.queued_at || new Date().toISOString(),
  };
}

function parseQueueJob(raw) {
  const job = JSON.parse(raw);
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('queue payload must be an object');
  return createQueueJob(job);
}

function createReliableListConsumer(redis, options = {}) {
  const token = options.token || crypto.randomUUID();
  const processingKey = `${PROCESSING_PREFIX}${token}`;
  const heartbeatKey = `${HEARTBEAT_PREFIX}${token}`;
  let heartbeatTimer = null;
  let stopped = false;

  async function recoverOrphans() {
    let cursor = '0';
    let recovered = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${PROCESSING_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        if (key === processingKey) continue;
        const owner = key.slice(PROCESSING_PREFIX.length);
        if (await redis.exists(`${HEARTBEAT_PREFIX}${owner}`)) continue;
        let raw;
        while ((raw = await redis.rpoplpush(key, MAIN_QUEUE))) recovered++;
      }
    } while (cursor !== '0');
    return recovered;
  }

  async function start() {
    stopped = false;
    await redis.set(heartbeatKey, new Date().toISOString(), 'EX', 15);
    const recovered = await recoverOrphans();
    heartbeatTimer = setInterval(() => {
      redis.set(heartbeatKey, new Date().toISOString(), 'EX', 15).catch(() => {});
    }, 5000);
    heartbeatTimer.unref?.();
    return recovered;
  }

  async function claim(timeoutSeconds = 1) {
    if (stopped) return null;
    return redis.call('BLMOVE', MAIN_QUEUE, processingKey, 'LEFT', 'RIGHT', String(timeoutSeconds));
  }

  async function acknowledge(raw, job) {
    const tx = redis.multi();
    if (job?.queue_job_id) tx.set(`${DONE_PREFIX}${job.queue_job_id}`, '1', 'EX', 604800);
    tx.lrem(processingKey, 1, raw);
    await tx.exec();
  }

  async function alreadyCompleted(job) {
    return job?.queue_job_id ? Boolean(await redis.exists(`${DONE_PREFIX}${job.queue_job_id}`)) : false;
  }

  async function reject(raw, job, error) {
    const attempt = Number(job?.queue_attempt || 0) + 1;
    const retry = Boolean(job && attempt <= MAX_RETRIES);
    const payload = retry
      ? JSON.stringify({ ...job, queue_attempt: attempt, last_error: String(error?.message || error), last_failed_at: new Date().toISOString() })
      : JSON.stringify({ job: job || null, raw: job ? undefined : raw, attempts: attempt, error: String(error?.message || error), failed_at: new Date().toISOString() });
    const tx = redis.multi().lrem(processingKey, 1, raw);
    if (retry) tx.rpush(MAIN_QUEUE, payload);
    else tx.rpush(DEAD_LETTER_QUEUE, payload);
    await tx.exec();
    return { retry, attempt };
  }

  async function stop() {
    stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    await redis.del(heartbeatKey).catch(() => {});
  }

  return { token, processingKey, start, claim, acknowledge, alreadyCompleted, reject, recoverOrphans, stop, isStopped: () => stopped };
}

async function scanKeys(redis, pattern) {
  let cursor = '0';
  const found = [];
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(next);
    found.push(...keys);
  } while (cursor !== '0');
  return found;
}

async function queueStats(redis) {
  const [pending, deadLetter, processingKeys, consumerKeys] = await Promise.all([
    redis.llen(MAIN_QUEUE),
    redis.llen(DEAD_LETTER_QUEUE),
    scanKeys(redis, `${PROCESSING_PREFIX}*`),
    scanKeys(redis, `${HEARTBEAT_PREFIX}*`),
  ]);
  const processingCounts = await Promise.all(processingKeys.map((key) => redis.llen(key)));
  return {
    pending,
    processing: processingCounts.reduce((sum, value) => sum + Number(value || 0), 0),
    dead_letter: deadLetter,
    consumers: consumerKeys.length,
  };
}

module.exports = {
  MAIN_QUEUE, PROCESSING_PREFIX, HEARTBEAT_PREFIX, DEAD_LETTER_QUEUE, DONE_PREFIX,
  MAX_RETRIES, createQueueJob, parseQueueJob, createReliableListConsumer, scanKeys, queueStats,
};
