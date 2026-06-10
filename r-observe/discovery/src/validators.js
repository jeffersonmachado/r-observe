'use strict';

/**
 * Validadores preventivos para evitar problemas comuns em producao.
 *
 * Regras:
 * - Policies: allowed_ranges deve usar CIDR completo (ex: 10.10.2.0/24), nunca prefixo parcial (ex: "10.")
 * - Policies: blocked_ranges deve ser array de strings validas
 * - Targets: addresses nao podem conter CIDR de redes Docker (172.x, 192.168.x)
 * - Targets: addresses devem ser IPs validos ou ranges explicitos
 * - Scan: total de IPs expandidos nao pode exceder maxHosts
 */

const { isValidIPv4 } = require('./scanners/target-expansion');

// Redes bloqueadas por padrao (loopback, link-local, multicast)
// Redes privadas (10.x, 172.16-31.x, 192.168.x) sao controladas pela politica (allowed_ranges/blocked_ranges)
const DEFAULT_BLOCKED_PREFIXES = [
  '127.', '169.254.', '224.', '255.',
];

const MAX_HOSTS_HARD_LIMIT = 100000;

/**
 * Valida uma politica de discovery.
 * Retorna { ok: true } ou { ok: false, errors: [...] }
 */
function validatePolicy(policy) {
  const errors = [];

  // 1. Nome obrigatorio
  if (!policy.name || String(policy.name).trim().length === 0) {
    errors.push('Policy name is required');
  }

  // 2. allowed_ranges deve ser array
  const allowed = Array.isArray(policy.allowed_ranges) ? policy.allowed_ranges : [];
  if (allowed.length === 0) {
    errors.push('allowed_ranges is empty — no targets will be discovered');
  }

  for (const range of allowed) {
    const err = validateRange(range, 'allowed_ranges');
    if (err) errors.push(err);
  }

  // 3. blocked_ranges deve ser array valido
  const blocked = Array.isArray(policy.blocked_ranges) ? policy.blocked_ranges : [];
  for (const range of blocked) {
    const err = validateRange(range, 'blocked_ranges');
    if (err) errors.push(err);
  }

  // 4. max_rate_per_minute
  if (policy.max_rate_per_minute && (policy.max_rate_per_minute < 1 || policy.max_rate_per_minute > 10000)) {
    errors.push(`max_rate_per_minute out of range: ${policy.max_rate_per_minute} (1-10000)`);
  }

  // 5. max_concurrency
  if (policy.max_concurrency && (policy.max_concurrency < 1 || policy.max_concurrency > 100)) {
    errors.push(`max_concurrency out of range: ${policy.max_concurrency} (1-100)`);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Valida um range individual.
 * Aceita: IP unico (10.10.2.1), CIDR (10.10.2.0/24), range (10.10.2.1-10.10.2.100)
 * Rejeita: prefixos parciais (10., 192.168.)
 */
function validateRange(range, field) {
  const trimmed = String(range || '').trim();

  if (!trimmed) {
    return `${field}: empty range`;
  }

  // IP unico
  if (isValidIPv4(trimmed)) return null;

  // CIDR: deve ter formato x.x.x.x/y
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length !== 2) return `${field}: invalid CIDR format "${trimmed}"`;
    if (!isValidIPv4(parts[0])) return `${field}: invalid IP in CIDR "${trimmed}"`;
    const mask = parseInt(parts[1], 10);
    if (isNaN(mask) || mask < 0 || mask > 32) return `${field}: invalid CIDR mask in "${trimmed}"`;
    return null;
  }

  // Range: x.x.x.x-y.y.y.y
  if (trimmed.includes('-')) {
    const parts = trimmed.split('-');
    if (parts.length !== 2) return `${field}: invalid range format "${trimmed}"`;
    if (!isValidIPv4(parts[0].trim())) return `${field}: invalid start IP in range "${trimmed}"`;
    if (!isValidIPv4(parts[1].trim())) return `${field}: invalid end IP in range "${trimmed}"`;
    return null;
  }

  // Hostname (para expansao DNS)
  if (/^[a-zA-Z][a-zA-Z0-9.-]+$/.test(trimmed)) return null;

  // Prefixo parcial detectado (ex: "10.", "192.168.")
  if (/^\d{1,3}\.$/.test(trimmed) || /^(\d{1,3}\.){1,2}$/.test(trimmed)) {
    return `${field}: partial prefix not allowed "${trimmed}" — use CIDR like "${trimmed}0.0/8" or "${trimmed}0/16"`;
  }

  // Nao reconhecido
  return `${field}: unrecognized format "${trimmed}"`;
}

/**
 * Valida um target individual.
 */
function validateTargetEntry(target, index) {
  const errors = [];
  const addr = String(target.address || target || '').trim();
  const prefix = `target[${index}] "${addr}"`;

  if (!addr) {
    errors.push(`${prefix}: empty address`);
    return errors;
  }

  // CIDR nos targets — permitido, a expansão filtra por allowed_ranges/blocked_ranges
  // (removida rejeição que bloqueava auto-discovery de subnets)

  // Detectar ranges de rede Docker
  for (const blocked of DEFAULT_BLOCKED_PREFIXES) {
    if (addr.startsWith(blocked)) {
      errors.push(`${prefix}: address in blocked Docker/private range (${blocked}...)`);
      break;
    }
  }

  // IP valido
  if (!isValidIPv4(addr) && !addr.includes('/') && !addr.includes('-')) {
    // Pode ser hostname - OK, mas logar
    if (!/^[a-zA-Z][a-zA-Z0-9.-]+$/.test(addr)) {
      errors.push(`${prefix}: not a valid IP or hostname`);
    }
  }

  return errors;
}

/**
 * Valida lista de targets.
 */
function validateTargets(targets) {
  const allErrors = [];
  for (let i = 0; i < targets.length; i++) {
    const errs = validateTargetEntry(targets[i], i);
    allErrors.push(...errs);
  }
  return allErrors.length ? { ok: false, errors: allErrors } : { ok: true };
}

/**
 * Valida estimativa de expansao antes de executar.
 */
function validateExpansionSize(targets, maxHosts = 65536) {
  if (maxHosts > MAX_HOSTS_HARD_LIMIT) {
    return { ok: false, error: `maxHosts ${maxHosts} exceeds hard limit ${MAX_HOSTS_HARD_LIMIT}` };
  }

  // Estimativa rapida: conta IPs + CIDRs
  let estimated = 0;
  for (const t of targets) {
    const addr = String(t.address || t || '').trim();
    if (isValidIPv4(addr)) {
      estimated += 1;
    } else if (addr.includes('/')) {
      const mask = parseInt(addr.split('/')[1], 10);
      if (!isNaN(mask) && mask >= 0 && mask <= 32) {
        estimated += Math.pow(2, 32 - mask);
      }
    } else if (addr.includes('-')) {
      estimated += 256; // estimativa conservadora para ranges
    } else {
      estimated += 1; // hostname = 1 IP
    }

    if (estimated > maxHosts) {
      return {
        ok: false,
        error: `Expansion estimate (${estimated}) exceeds maxHosts (${maxHosts}). ` +
               `Check for CIDR targets in observe_discovery_targets or overly broad allowed_ranges.`
      };
    }
  }

  return { ok: true, estimated };
}

module.exports = {
  validatePolicy,
  validateTargets,
  validateTargetEntry,
  validateRange,
  validateExpansionSize,
  MAX_HOSTS_HARD_LIMIT,
  DEFAULT_BLOCKED_PREFIXES,
};
