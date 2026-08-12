'use strict';

/**
 * SNMP Deep Walk Engine — faz snmpwalk/snmpbulkwalk com timeout e parsing.
 *
 * Suporta:
 *   - snmpwalk (v1/v2c) — fallback
 *   - snmpbulkwalk (v2c) — rápido, uma requisição
 *   - snmpget para OIDs pontuais
 *   - Timeouts configuráveis
 *   - Parsing de saída para objetos estruturados
 *
 * Requer: net-snmp-utils (snmpwalk, snmpbulkwalk, snmpget)
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { log } = require('../utils/logger');
const { isValidHost } = require('../validators');

const execFileAsync = promisify(execFile);

const DEFAULT_COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const DEFAULT_TIMEOUT = parseInt(process.env.SNMP_TIMEOUT_MS || '15000', 10);
const DEFAULT_VERSION = process.env.SNMP_VERSION || '2c';
const MAX_RETRIES = parseInt(process.env.SNMP_RETRIES || '1', 10);

/**
 * Limpa valor SNMP: remove tipo ("STRING: ", "INTEGER: ", etc.) e aspas.
 */
function cleanSnmpValue(raw) {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).trim();
  // Remove type prefix
  value = value.replace(/^(STRING|INTEGER|Gauge32|Counter32|Counter64|Timeticks|Hex-STRING|OID|IpAddress|Network Address|BITS|Opaque|Unsigned32)\s*:\s*/i, '');
  // Remove aspas
  value = value.replace(/^"|"$/g, '').trim();
  return value || null;
}

/**
 * Executa snmpwalk e retorna array de linhas.
 */
async function snmpWalk(host, oid, opts = {}) {
  const community = opts.community || DEFAULT_COMMUNITY;
  const timeout = (opts.timeout || DEFAULT_TIMEOUT) / 1000; // snmpwalk usa segundos
  const version = opts.version || DEFAULT_VERSION;
  const retries = Math.max(0, Math.min(5, Number(opts.retries ?? MAX_RETRIES) || 0));
  if (!isValidHost(host) || !isValidOid(oid)) return [];

  // Prefere snmpbulkwalk para v2c (muito mais rápido)
  const bulk = version === '2c' && !opts.noBulk;
  const file = bulk ? 'snmpbulkwalk' : 'snmpwalk';
  const safeVersion = ['1', '2c'].includes(version) ? version : DEFAULT_VERSION;
  const args = [`-v${safeVersion}`, '-c', String(community)];
  if (bulk) args.push('-Cr50');
  args.push('-t', String(timeout), '-r', String(retries), host, oid);

  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: (timeout * 1000) + 10000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return (stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  } catch (e) {
    // Timeout ou host unreachable
    if (e.killed || e.signal === 'SIGTERM') {
      log('warn', `SNMP walk timeout for ${host}:${oid}`, { err: 'timeout' });
    } else if (e.stderr && /timeout|no response/i.test(e.stderr)) {
      log('warn', `SNMP no response from ${host}:${oid}`, { err: 'no_response' });
    } else {
      log('warn', `SNMP walk failed for ${host}:${oid}`, { err: e.message });
    }
    return [];
  }
}

/**
 * snmpget para OIDs pontuais.
 */
async function snmpGet(host, oids, opts = {}) {
  const community = opts.community || DEFAULT_COMMUNITY;
  const timeout = (opts.timeout || DEFAULT_TIMEOUT) / 1000;
  const version = opts.version || DEFAULT_VERSION;
  const retries = Math.max(0, Math.min(5, Number(opts.retries ?? MAX_RETRIES) || 0));

  const oidList = Array.isArray(oids) ? oids : [oids];
  const validOids = oidList.filter(isValidOid);
  if (!isValidHost(host) || validOids.length !== oidList.length) {
    return Array.isArray(oids) ? oids.map(() => null) : null;
  }
  const safeVersion = ['1', '2c'].includes(version) ? version : DEFAULT_VERSION;

  try {
    const { stdout } = await execFileAsync(
      'snmpget', [`-v${safeVersion}`, '-c', String(community), '-t', String(timeout),
        '-r', String(retries), '-Oqv', host, ...validOids],
      { timeout: (timeout * 1000) + 10000 }
    );

    const lines = (stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 1) return cleanSnmpValue(lines[0]);

    return lines.map(cleanSnmpValue);
  } catch (e) {
    log('warn', `SNMP get failed for ${host}`, { err: e.message });
    return Array.isArray(oids) ? oids.map(() => null) : null;
  }
}

/**
 * Parse uma linha de snmpwalk para { oid, index, value }.
 * Ex: "IF-MIB::ifDescr.1 = STRING: eth0" → { oid: "IF-MIB::ifDescr.1", index: "1", value: "eth0" }
 */
function parseWalkLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;

  const eqIdx = text.indexOf(' = ');
  if (eqIdx < 0) return null;

  const oidPart = text.slice(0, eqIdx).trim();
  const valueRaw = text.slice(eqIdx + 3).trim();

  // Extrai índice (último número após o ponto no OID)
  const parts = oidPart.split('.');
  const index = parts.length > 1 ? parts[parts.length - 1] : null;

  return {
    oid: oidPart,
    index: index && /^\d+$/.test(index) ? index : null,
    value: cleanSnmpValue(valueRaw),
    raw: text,
  };
}

/**
 * Executa snmpwalk e retorna array de { oid, index, value } parseados.
 */
async function snmpWalkParsed(host, oid, opts = {}) {
  const lines = await snmpWalk(host, oid, opts);
  return lines.map(parseWalkLine).filter(Boolean);
}

/**
 * Executa walk e retorna mapa index → value.
 */
async function snmpWalkIndexed(host, oid, opts = {}) {
  const parsed = await snmpWalkParsed(host, oid, opts);
  const map = {};
  for (const p of parsed) {
    if (p.index !== null) {
      map[p.index] = p.value;
    }
  }
  return map;
}

/**
 * Walk múltiplos OIDs em paralelo.
 */
async function snmpMultiWalk(host, oids, opts = {}) {
  const results = {};
  const promises = oids.map(async ({ name, oid }) => {
    results[name] = await snmpWalkIndexed(host, oid, opts);
  });
  await Promise.all(promises);
  return results;
}

function escapeShell(str) {
  return `'${String(str).replace(/'/g, `'"'"'`)}'`;
}

function isValidOid(value) {
  return typeof value === 'string' && value.length <= 256 &&
    /^(?:\.?\d+(?:\.\d+)*|[A-Za-z][A-Za-z0-9-]*::[A-Za-z0-9-]+(?:\.\d+)*)$/.test(value);
}

module.exports = {
  snmpWalk,
  snmpGet,
  snmpWalkParsed,
  snmpWalkIndexed,
  snmpMultiWalk,
  parseWalkLine,
  cleanSnmpValue,
  escapeShell,
  isValidOid,
};
