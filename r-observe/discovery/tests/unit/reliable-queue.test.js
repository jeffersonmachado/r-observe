'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAIN_QUEUE, DEAD_LETTER_QUEUE, createQueueJob, parseQueueJob, createReliableListConsumer, queueStats,
} = require('../../src/queues/reliable-list');

function fakeRedis() {
  const calls = [];
  const tx = () => {
    const ops = [];
    const chain = {
      lrem: (...args) => { ops.push(['lrem', ...args]); return chain; },
      rpush: (...args) => { ops.push(['rpush', ...args]); return chain; },
      set: (...args) => { ops.push(['set', ...args]); return chain; },
      exec: async () => { calls.push(...ops); return []; },
    };
    return chain;
  };
  return { calls, multi: tx, set: async () => 'OK', del: async () => 1 };
}

test('queue job recebe identidade estável e tentativa inicial', () => {
  const job = createQueueJob({ tenant_id: 'tenant-a' });
  assert.match(job.queue_job_id, /^[0-9a-f-]{36}$/);
  assert.equal(job.queue_attempt, 0);
  assert.equal(parseQueueJob(JSON.stringify(job)).queue_job_id, job.queue_job_id);
  assert.throws(() => parseQueueJob('not-json'));
});

test('falha transitória remove processing e reenfileira com tentativa incrementada', async () => {
  const redis = fakeRedis();
  const consumer = createReliableListConsumer(redis, { token: 'worker-a' });
  const job = createQueueJob({ queue_job_id: 'job-1' });
  const result = await consumer.reject(JSON.stringify(job), job, new Error('temporary'));
  assert.equal(result.retry, true);
  assert.equal(redis.calls[0][0], 'lrem');
  assert.deepEqual(redis.calls[1].slice(0, 2), ['rpush', MAIN_QUEUE]);
  assert.equal(JSON.parse(redis.calls[1][2]).queue_attempt, 1);
});

test('payload inválido vai diretamente para dead letter', async () => {
  const redis = fakeRedis();
  const consumer = createReliableListConsumer(redis, { token: 'worker-a' });
  const result = await consumer.reject('bad', null, new Error('invalid'));
  assert.equal(result.retry, false);
  assert.deepEqual(redis.calls[1].slice(0, 2), ['rpush', DEAD_LETTER_QUEUE]);
});

test('queueStats agrega backlog, processing, DLQ e consumidores sem KEYS', async () => {
  const lengths = new Map([
    [MAIN_QUEUE, 8], [DEAD_LETTER_QUEUE, 2],
    ['observe:scan:network:processing:a', 1], ['observe:scan:network:processing:b', 3],
  ]);
  const redis = {
    scan: async (cursor, _match, pattern) => pattern.includes('processing')
      ? ['0', ['observe:scan:network:processing:a', 'observe:scan:network:processing:b']]
      : ['0', ['observe:scan:network:consumer:a']],
    llen: async (key) => lengths.get(key) || 0,
  };
  assert.deepEqual(await queueStats(redis), { pending: 8, processing: 4, dead_letter: 2, consumers: 1 });
});

test('queue_job_id é propagado pelo consumidor até scan:results', () => {
  const index = fs.readFileSync(path.resolve(__dirname, '../../src/index.js'), 'utf8');
  const engine = fs.readFileSync(path.resolve(__dirname, '../../src/engine/discovery-engine.js'), 'utf8');
  assert.match(index, /queue_job_id:\s*task\.queue_job_id/);
  assert.match(engine, /queue_job_id:\s*input\.queue_job_id/);
});
