'use strict';

const crypto = require('node:crypto');

function scopeKey(scope = {}) {
  return [scope.tenant_id || 'default', scope.site_id || 'default-site', scope.edge_id || 'central']
    .map((value) => encodeURIComponent(String(value))).join(':');
}

async function acquireScanAdmission(redis, scope, maxSlots = 1, ttlSeconds = 7200) {
  if (!redis) return null;
  const slots = Math.max(1, Math.min(50, parseInt(maxSlots || '1', 10)));
  const token = crypto.randomUUID();
  for (let slot = 0; slot < slots; slot++) {
    const key = `observe:scan:admission:${scopeKey(scope)}:${slot}`;
    if (await redis.set(key, token, 'EX', ttlSeconds, 'NX') === 'OK') return { key, token, slot };
  }
  return null;
}

async function releaseScanAdmission(redis, admission) {
  if (!redis || !admission?.key || !admission?.token) return 0;
  return redis.eval(
    "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
    1, admission.key, admission.token
  );
}

function admissionFromJob(job = {}) {
  return job.queue_admission_key && job.queue_admission_token
    ? { key: job.queue_admission_key, token: job.queue_admission_token }
    : null;
}

module.exports = { scopeKey, acquireScanAdmission, releaseScanAdmission, admissionFromJob };
