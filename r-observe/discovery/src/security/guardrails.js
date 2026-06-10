'use strict';

const { isIpInRange } = require('../scanners/target-expansion');

const DEFAULT_BLOCKED_RANGES = [
  '127.0.0.0/8',
  '0.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '255.255.255.255',
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function validateTarget(target, policy) {
  const allow = asArray(policy.allowed_ranges);
  const deny = [...DEFAULT_BLOCKED_RANGES, ...asArray(policy.blocked_ranges)];

  if (deny.some((p) => isIpInRange(target.address, p))) {
    return { ok: false, reason: 'blocked_range' };
  }
  if (allow.length > 0 && !allow.some((p) => isIpInRange(target.address, p))) {
    return { ok: false, reason: 'outside_allowlist' };
  }
  return { ok: true };
}

function normalizePolicy(row) {
  const profile = row.scan_profile || 'safe';
  const allow = asArray(row.allowed_ranges);
  const deny = asArray(row.blocked_ranges);

  return {
    profile,
    allowed_ranges: allow,
    blocked_ranges: deny,
    max_rate_per_minute: row.max_rate_per_minute || 300,
    host_timeout_ms: row.host_timeout_ms || (profile === 'safe' ? 12000 : 8000),
    max_concurrency: row.max_concurrency || (profile === 'safe' ? 5 : profile === 'balanced' ? 15 : 30),
    allow_udp: row.allow_udp === true,
    passive_enabled: row.passive_enabled !== false,
    active_enabled: row.active_enabled !== false,
    auto_prometheus_sd: row.auto_prometheus_sd !== false,
    auto_icinga_sync: row.auto_icinga_sync === true,
  };
}

module.exports = { validateTarget, normalizePolicy };
