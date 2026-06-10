'use strict';

const dns = require('dns').promises;
const { log } = require('../utils/logger');

const MAX_HOSTS_DEFAULT = 65536;
const MAX_SCAN_TARGETS_DEFAULT = 512;
const CHUNK_SIZE = 256;
const MAX_IPV4 = 0xffffffff;

/**
 * Strict IPv4 parser.
 */
function parseIPv4(ipStr) {
  if (typeof ipStr !== 'string') {
    throw new Error('IPv4 must be a string');
  }

  if (ipStr !== ipStr.trim()) {
    throw new Error('IPv4 must not contain leading/trailing spaces');
  }

  const parts = ipStr.split('.');
  if (parts.length !== 4) {
    throw new Error('IPv4 must have 4 octets');
  }

  const octets = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error('IPv4 octets must be numeric');
    }

    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('IPv4 octet out of range');
    }
    octets.push(value);
  }

  return octets;
}

/**
 * Parse IP address string to unsigned number for comparison.
 */
function ipToNumber(ipStr) {
  const parts = parseIPv4(ipStr);
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]);
}

/**
 * Convert IP number back to string.
 */
function numberToIp(num) {
  const safeNum = Number(num);
  if (!Number.isInteger(safeNum) || safeNum < 0 || safeNum > MAX_IPV4) {
    throw new Error('Invalid IPv4 integer');
  }

  return [
    Math.floor(safeNum / 16777216) % 256,
    Math.floor(safeNum / 65536) % 256,
    Math.floor(safeNum / 256) % 256,
    safeNum % 256,
  ].join('.');
}

/**
 * Validates if value is a strict IPv4 string.
 */
function isValidIPv4(ipStr) {
  try {
    parseIPv4(ipStr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse CIDR notation and return range metadata.
 */
function parseCidrSpec(cidrStr) {
  const parts = String(cidrStr || '').split('/');
  if (parts.length !== 2) {
    throw new Error('CIDR must contain exactly one slash');
  }

  const [ipStr, maskStr] = parts;
  if (!/^\d+$/.test(maskStr)) {
    throw new Error(`Invalid CIDR mask: ${maskStr}`);
  }

  const mask = parseInt(maskStr, 10);

  if (mask < 0 || mask > 32) {
    throw new Error(`Invalid CIDR mask: ${mask}`);
  }

  const ipNum = ipToNumber(ipStr);
  const blockSize = 2 ** (32 - mask);
  const networkNum = Math.floor(ipNum / blockSize) * blockSize;
  const broadcastNum = networkNum + blockSize - 1;

  return {
    type: 'cidr',
    normalized: `${numberToIp(networkNum)}/${mask}`,
    ipNum,
    networkNum,
    broadcastNum,
    mask,
    hostBits: blockSize,
    totalIps: blockSize,
  };
}

function parsePrefixSpec(prefixStr) {
  const candidate = String(prefixStr || '').trim();
  if (!/^(?:\d{1,3}\.){1,3}$/.test(candidate)) {
    throw new Error(`Invalid IPv4 prefix: ${candidate}`);
  }

  const parts = candidate.split('.').filter(Boolean);
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid IPv4 prefix: ${candidate}`);
    }
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`Invalid IPv4 prefix: ${candidate}`);
    }
    return value;
  });

  const mask = octets.length * 8;
  while (octets.length < 4) octets.push(0);
  return parseCidrSpec(`${octets.join('.')}/${mask}`);
}

/**
 * Parse CIDR notation: 10.10.2.0/24
 */
function parseCidr(cidrStr, options = {}) {
  const spec = parseCidrSpec(cidrStr);
  if (spec.totalIps > options.maxHosts) {
    throw new Error(`CIDR ${spec.normalized} exceeds maxHosts (${options.maxHosts})`);
  }

  const ips = [];
  for (let i = spec.networkNum; i <= spec.broadcastNum; i++) {
    ips.push(numberToIp(i));
  }

  return {
    type: 'cidr',
    ips,
    normalized: spec.normalized,
    totalIps: ips.length,
  };
}

function parseRangeSpec(rangeStr) {
  const parts = String(rangeStr || '').split('-');
  if (parts.length !== 2) {
    throw new Error('Range must contain exactly one dash');
  }

  const [startStr, endStr] = parts;
  const startNum = ipToNumber(startStr.trim());
  const endNum = ipToNumber(endStr.trim());

  if (endNum < startNum) {
    throw new Error('Range end is before start');
  }

  return {
    type: 'range',
    normalized: `${numberToIp(startNum)}-${numberToIp(endNum)}`,
    startNum,
    endNum,
    totalIps: endNum - startNum + 1,
  };
}

/**
 * Parse range notation: 10.10.2.1-10.10.2.100
 */
function parseRange(rangeStr) {
  const spec = parseRangeSpec(rangeStr);

  const ips = [];
  for (let i = spec.startNum; i <= spec.endNum; i++) {
    ips.push(numberToIp(i));
  }

  return {
    type: 'range',
    ips,
    normalized: spec.normalized,
    totalIps: ips.length,
  };
}

function estimateTargetSize(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('Empty target');

  if (isValidIPv4(trimmed) || trimmed.toLowerCase() === 'localhost') {
    return 1;
  }

  if (trimmed.includes('/')) {
    return parseCidrSpec(trimmed).totalIps;
  }

  if (trimmed.includes('-')) {
    return parseRangeSpec(trimmed).totalIps;
  }

  return 1;
}

function compileRangeMatcher(range) {
  const candidate = String(range || '').trim();
  if (!candidate) {
    throw new Error('Empty include/exclude range');
  }

  if (isValidIPv4(candidate)) {
    const target = ipToNumber(candidate);
    return (ipNum) => ipNum === target;
  }

  if (candidate.includes('/')) {
    const cidr = parseCidrSpec(candidate);
    return (ipNum) => ipNum >= cidr.networkNum && ipNum <= cidr.broadcastNum;
  }

  if (candidate.includes('-')) {
    const rangeSpec = parseRangeSpec(candidate);
    return (ipNum) => ipNum >= rangeSpec.startNum && ipNum <= rangeSpec.endNum;
  }

  if (candidate.endsWith('.')) {
    const prefix = parsePrefixSpec(candidate);
    return (ipNum) => ipNum >= prefix.networkNum && ipNum <= prefix.broadcastNum;
  }

  throw new Error(`Invalid include/exclude range: ${candidate}`);
}

/**
 * Parses an IP address or hostname and returns normalized IP.
 * Supports:
 * - Single IPv4: 10.10.2.1
 * - CIDR: 10.10.2.0/24
 * - Range: 10.10.2.1-10.10.2.100
 * - Hostname: example.local
 * - FQDN: example.results.intranet
 */
async function parseTarget(input) {
  const trimmed = String(input || '').trim();

  if (!trimmed) {
    throw new Error('Empty target');
  }

  // Single IP
  if (isValidIPv4(trimmed)) {
    return {
      type: 'single_ip',
      ips: [trimmed],
      normalized: trimmed,
    };
  }

  if (trimmed.toLowerCase() === 'localhost') {
    return {
      type: 'hostname',
      ips: ['127.0.0.1'],
      normalized: trimmed,
      hostname: trimmed,
      resolvedIps: 1,
    };
  }

  // CIDR notation: 10.10.2.0/24
  if (trimmed.includes('/')) {
    try {
      const result = parseCidr(trimmed, { maxHosts: MAX_HOSTS_DEFAULT });
      // Exclude network and broadcast only for /24 (256 hosts) or larger subnets
      const mask = parseInt(trimmed.split('/')[1], 10);
      if (mask <= 24 && result.ips.length > 2) {
        return {
          ...result,
          usableIps: result.ips.length - 2,
          ips: result.ips.slice(1, -1),
        };
      }
      return result;
    } catch (e) {
      throw new Error(`Invalid CIDR notation: ${trimmed} - ${e.message}`);
    }
  }

  // Range notation: 10.10.2.1-10.10.2.100
  if (trimmed.includes('-')) {
    try {
      return parseRange(trimmed);
    } catch (e) {
      throw new Error(`Invalid range notation: ${trimmed} - ${e.message}`);
    }
  }

  if (/^[0-9.]+$/.test(trimmed)) {
    throw new Error(`Cannot parse target '${trimmed}': invalid IPv4 address`);
  }

  // Hostname or FQDN: resolve to IP(s)
  try {
    const addresses = await dns.resolve4(trimmed);
    const validAddresses = (addresses || []).filter((a) => isValidIPv4(a) && a !== '0.0.0.0');
    if (!validAddresses.length) {
      throw new Error(`Hostname does not resolve or returned invalid address`);
    }

    return {
      type: 'hostname',
      ips: validAddresses,
      normalized: trimmed,
      hostname: trimmed,
      resolvedIps: validAddresses.length,
    };
  } catch (e) {
    throw new Error(`Cannot parse target '${trimmed}': not IP, CIDR, range, or resolvable hostname - ${e.message}`);
  }
}

/**
 * Expands a list of targets into individual IPs, with protection against
 * excessively large scans.
 *
 * Options:
 * - maxHosts: Maximum individual IPs to allow (default: 65536)
 * - maxScanTargets: Maximum targets to return (default: 512)
 * - excludeRanges: Array of IP ranges to exclude
 * - includeRanges: Array of IP ranges to include (allowlist)
 */
async function expandTargets(targets = [], options = {}) {
  const maxHosts = options.maxHosts || MAX_HOSTS_DEFAULT;
  const maxScanTargets = options.maxScanTargets || MAX_SCAN_TARGETS_DEFAULT;
  const excludeRanges = Array.isArray(options.excludeRanges) ? options.excludeRanges : [];
  const includeRanges = Array.isArray(options.includeRanges) ? options.includeRanges : [];

  if (!Array.isArray(targets)) {
    throw new Error('targets must be an array');
  }

  const estimatedTotal = targets.reduce((acc, target) => acc + estimateTargetSize(target), 0);
  if (estimatedTotal > maxHosts) {
    throw new Error(
      `Target expansion exceeded maxHosts limit (${maxHosts}). ` +
      `${estimatedTotal} IPs would be scanned.`
    );
  }

  const excludeMatchers = excludeRanges.map((range) => compileRangeMatcher(range));
  const includeMatchers = includeRanges.map((range) => compileRangeMatcher(range));

  const allIps = [];

  for (const target of targets) {
    try {
      const parsed = await parseTarget(target);
      allIps.push(...parsed.ips);

      if (allIps.length > maxHosts) {
        throw new Error(
          `Target expansion exceeded maxHosts limit (${maxHosts}). ` +
          `${allIps.length} IPs would be scanned.`
        );
      }
    } catch (e) {
      log('warn', `Failed to parse target: ${target}`, { error: e.message });
      throw e;
    }
  }

  // Deduplicate and sort
  const uniqueIps = [...new Set(allIps)].sort((a, b) => {
    return ipToNumber(a) - ipToNumber(b);
  });

  // Apply filters
  const filteredOut = [];
  let filtered = [];
  for (const ip of uniqueIps) {
    const ipNum = ipToNumber(ip);
    let reason = null;

    for (const exclude of excludeMatchers) {
      if (exclude(ipNum)) {
        reason = 'blocked_range';
        break;
      }
    }

    if (!reason && includeMatchers.length > 0) {
      let found = false;
      for (const include of includeMatchers) {
        if (include(ipNum)) {
          found = true;
          break;
        }
      }
      if (!found) reason = 'outside_allowlist';
    }

    if (reason) filteredOut.push({ address: ip, discovery_type: 'ip', reason });
    else filtered.push(ip);
  }

  if (filtered.length > maxScanTargets) {
    log('warn', `Target expansion reduced from ${filtered.length} to ${maxScanTargets} due to limit`, {
      original_count: filtered.length,
      max_scan_targets: maxScanTargets,
    });
    filteredOut.push(...filtered.slice(maxScanTargets).map((ip) => ({
      address: ip,
      discovery_type: 'ip',
      reason: 'max_scan_targets_limit',
    })));
    filtered = filtered.slice(0, maxScanTargets);
  }

  return {
    totalExpanded: allIps.length,
    totalUnique: uniqueIps.length,
    totalFiltered: filtered.length,
    filteredOut,
    targets: filtered.map((ip) => ({
      address: ip,
      discovery_type: 'ip',
    })),
  };
}

/**
 * Check if an IP is within a range.
 * Range can be:
 * - Single IP: 10.10.2.1
 * - CIDR: 10.10.2.0/24
 * - Range: 10.10.2.1-10.10.2.100
 * - Legacy prefix: 10.10.
 */
function isIpInRange(ip, range) {
  try {
    const candidate = String(range || '').trim();
    if (!candidate) return false;

    const ipNum = ipToNumber(ip);

    // Single IP
    if (isValidIPv4(candidate)) {
      return ipNum === ipToNumber(candidate);
    }

    // CIDR
    if (candidate.includes('/')) {
      const cidrSpec = parseCidrSpec(candidate);
      return ipNum >= cidrSpec.networkNum && ipNum <= cidrSpec.broadcastNum;
    }

    // Range
    if (candidate.includes('-')) {
      const rangeSpec = parseRangeSpec(candidate);
      return ipNum >= rangeSpec.startNum && ipNum <= rangeSpec.endNum;
    }

    if (candidate.endsWith('.')) {
      const prefix = parsePrefixSpec(candidate);
      return ipNum >= prefix.networkNum && ipNum <= prefix.broadcastNum;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Chunks expanded targets into groups for concurrent processing.
 */
function chunkTargets(targets, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < targets.length; i += chunkSize) {
    chunks.push(targets.slice(i, i + chunkSize));
  }
  return chunks;
}

module.exports = {
  isValidIPv4,
  parseTarget,
  expandTargets,
  isIpInRange,
  chunkTargets,
  MAX_HOSTS_DEFAULT,
  MAX_SCAN_TARGETS_DEFAULT,
};
