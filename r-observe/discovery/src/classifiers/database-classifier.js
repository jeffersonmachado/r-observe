'use strict';

/**
 * R-Observe Discovery — Database Classifier (Enterprise)
 *
 * Classifica bancos de dados com base em:
 *   - Porta padrão
 *   - Banner de conexão
 *   - Resposta a probes específicos
 *   - TLS certificate
 *   - SNMP
 *
 * Bancos suportados:
 *   - MariaDB / MySQL, PostgreSQL, MongoDB, Redis, Elasticsearch
 *   - Oracle DB, Microsoft SQL Server, Cassandra, Couchbase
 *   - Neo4j, TimescaleDB, CockroachDB, InfluxDB
 */

const { log } = require('../utils/logger');
const net = require('net');

const DETECTION_METHODS = {
  TCP_BANNER: 'tcp_banner',
  QUERY_RESPONSE: 'query_response',
  TLS_CERTIFICATE: 'tls_certificate',
  PORT_MATCH: 'port_match',
  SNMP: 'snmp',
};
const MIN_DATABASE_CONFIDENCE = 0.5;

function nowIso() { return new Date().toISOString(); }
function clamp(v, min = 0, max = 1) { return Math.max(min, Math.min(max, v)); }

function makeEvidence(type, source, confidence, raw = null, normalized = {}) {
  return {
    evidence_type: type,
    evidence_source: source,
    confidence: clamp(confidence),
    raw_data: raw,
    normalized_data: normalized,
    timestamp: nowIso(),
  };
}

// ─── TCP Banner Reader ───────────────────────────────────────────────────────

function readTcpBanner(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let result = { open: false, banner: null, error: null };
    let resolved = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => { result.open = true; });
    socket.on('data', (data) => {
      result.banner = data.toString('utf-8').slice(0, 2048);
      // Não fecha ainda — aguarda mais dados ou timeout
    });
    socket.on('timeout', () => { socket.destroy(); });
    socket.on('error', (err) => { result.error = err.message; socket.destroy(); });
    socket.on('close', () => {
      if (!resolved) { resolved = true; resolve(result); }
    });
    socket.connect(port, host);
  });
}

// ─── PostgreSQL Probe ────────────────────────────────────────────────────────

function parsePostgresBanner(banner) {
  if (!banner) return null;
  const info = {};
  // Startup message response: usually first byte is message type
  // For version query response
  const versionMatch = banner.match(/PostgreSQL\s+([\d.]+)/i);
  if (versionMatch) info.version = versionMatch[1];

  // SSL supported check
  if (banner.includes('S') || banner.charCodeAt(0) === 83) {
    info.ssl_supported = true;
  }

  info.vendor = 'PostgreSQL';
  info.confidence = versionMatch ? 0.95 : 0.6;
  return info;
}

// ─── MySQL/MariaDB Probe ─────────────────────────────────────────────────────

function parseMysqlBanner(banner) {
  if (!banner) return null;
  const info = {};
  const text = banner.toString('utf-8');

  // MySQL handshake packet starts with protocol version
  if (text.includes('mysql') || banner.length > 40) {
    const versionMatch = text.match(/(\d+\.\d+\.\d+)(?:-MariaDB)?/);

    if (text.includes('MariaDB') || banner.toString().includes('MariaDB')) {
      info.vendor = 'MariaDB';
      info.confidence = 0.9;
    } else {
      info.vendor = 'MySQL';
      info.confidence = 0.85;
    }

    if (versionMatch) info.version = versionMatch[1];
  }

  return info;
}

// ─── MongoDB Probe ───────────────────────────────────────────────────────────

function parseMongoBanner(banner) {
  if (!banner) return null;
  const info = {};
  const text = banner.toString('utf-8');

  // MongoDB wire protocol: msg header has 4 sections
  if (text.includes('ismaster') || text.includes('buildinfo') || text.includes('maxBsonObjectSize')) {
    info.vendor = 'MongoDB';
    const versionMatch = text.match(/"version"\s*:\s*"([\d.]+)"/);
    if (versionMatch) info.version = versionMatch[1];
    info.confidence = versionMatch ? 0.95 : 0.75;
  }

  return info;
}

// ─── Redis Probe ─────────────────────────────────────────────────────────────

function parseRedisBanner(banner) {
  if (!banner) return null;
  const info = {};
  const text = banner.toString('utf-8');

  // Redis responds to PING with +PONG
  if (text.startsWith('+PONG') || text.includes('redis_version') || text.startsWith('-NOAUTH') || text.startsWith('-ERR')) {
    info.vendor = 'Redis';
    const versionMatch = text.match(/redis_version:([\d.]+)/);
    if (versionMatch) info.version = versionMatch[1];
    info.confidence = versionMatch ? 0.95 : (text.startsWith('-NOAUTH') ? 0.9 : 0.7);
  }

  return info;
}

async function probeRedis(host, port = 6379, password = null) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let result = { vendor: null, version: null, confidence: 0, auth_required: false };
    let resolved = false;

    socket.setTimeout(3000);
    socket.on('connect', () => {
      // Send INFO command
      const cmd = password
        ? `AUTH ${password}\r\nINFO SERVER\r\n`
        : 'INFO SERVER\r\n';
      socket.write(cmd);
    });
    socket.on('data', (data) => {
      const text = data.toString();
      result = parseRedisBanner(text) || result;
      if (!resolved) { resolved = true; resolve(result); }
      socket.destroy();
    });
    socket.on('timeout', () => { if (!resolved) { resolved = true; resolve(result); } socket.destroy(); });
    socket.on('error', () => { if (!resolved) { resolved = true; resolve(result); } socket.destroy(); });
    socket.on('close', () => { if (!resolved) { resolved = true; resolve(result); } });

    socket.connect(port, host);
  });
}

// ─── Elasticsearch Probe ─────────────────────────────────────────────────────

async function probeElasticsearch(host, port = 9200) {
  try {
    const resp = await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await resp.json();
    const info = {
      vendor: 'Elasticsearch',
      version: body.version?.number || null,
      cluster_name: body.cluster_name || null,
      tagline: body.tagline || null,
      confidence: body.version ? 0.95 : 0.7,
    };
    return info;
  } catch (_) {
    return null;
  }
}

// ─── Main Classification ─────────────────────────────────────────────────────

const DB_PORT_MAP = {
  3306: { vendor: 'MySQL/MariaDB', default_protocol: 'tcp', parser: parseMysqlBanner },
  33060: { vendor: 'MySQL X Protocol', default_protocol: 'tcp' },
  5432: { vendor: 'PostgreSQL', default_protocol: 'tcp', parser: parsePostgresBanner },
  27017: { vendor: 'MongoDB', default_protocol: 'tcp', parser: parseMongoBanner },
  27018: { vendor: 'MongoDB', default_protocol: 'tcp', parser: parseMongoBanner },
  27019: { vendor: 'MongoDB (config)', default_protocol: 'tcp', parser: parseMongoBanner },
  6379: { vendor: 'Redis', default_protocol: 'tcp', probe: probeRedis },
  6380: { vendor: 'Redis (TLS)', default_protocol: 'tcp' },
  9200: { vendor: 'Elasticsearch', default_protocol: 'tcp', http_probe: probeElasticsearch },
  9300: { vendor: 'Elasticsearch (transport)', default_protocol: 'tcp' },
  1521: { vendor: 'Oracle DB', default_protocol: 'tcp' },
  2483: { vendor: 'Oracle DB (TLS)', default_protocol: 'tcp' },
  1433: { vendor: 'Microsoft SQL Server', default_protocol: 'tcp' },
  9042: { vendor: 'Cassandra', default_protocol: 'tcp' },
  7687: { vendor: 'Neo4j (Bolt)', default_protocol: 'tcp' },
  7474: { vendor: 'Neo4j (HTTP)', default_protocol: 'tcp' },
  8086: { vendor: 'InfluxDB', default_protocol: 'tcp' },
  26257: { vendor: 'CockroachDB', default_protocol: 'tcp' },
  11210: { vendor: 'Couchbase', default_protocol: 'tcp' },
  8091: { vendor: 'Couchbase (Web)', default_protocol: 'tcp' },
  4222: { vendor: 'NATS', default_protocol: 'tcp' },
  5672: { vendor: 'RabbitMQ', default_protocol: 'tcp' },
};

/**
 * @param {object} input
 *   - ip: string
 *   - open_ports: number[]
 * @returns {object[]}
 */
async function classifyDatabase(input = {}) {
  const ip = input.ip || input.address;
  if (!ip) return [];

  const openPorts = (input.open_ports || []).map(p => typeof p === 'number' ? p : p.port);
  const results = [];

  for (const port of openPorts) {
    const mapping = DB_PORT_MAP[port];
    if (!mapping) continue;

    const result = {
      port,
      protocol: mapping.default_protocol,
      vendor: mapping.vendor,
      version: null,
      confidence_score: 0.4,
      evidence: [],
      timestamp: nowIso(),
    };

    // Port match base evidence
    result.evidence.push(makeEvidence(DETECTION_METHODS.PORT_MATCH, 'db-classifier', 0.4, { port },
      { vendor: mapping.vendor }));

    // TCP Banner
    if (mapping.parser && mapping.default_protocol === 'tcp') {
      const bannerResult = await readTcpBanner(ip, port, 3000);
      if (bannerResult.open && bannerResult.banner) {
        const parsed = mapping.parser(bannerResult.banner);
        if (parsed && parsed.vendor) {
          result.vendor = parsed.vendor;
          result.version = parsed.version || null;
          result.confidence_score = parsed.confidence || 0.85;

          result.evidence.push(makeEvidence(DETECTION_METHODS.TCP_BANNER, 'db-classifier',
            parsed.confidence || 0.85,
            bannerResult.banner.slice(0, 500),
            { vendor: parsed.vendor, version: parsed.version }));
        }
      }
    }

    // Special probes (Redis, Elasticsearch)
    if (mapping.probe) {
      const probeResult = await mapping.probe(ip, port);
      if (probeResult && probeResult.vendor) {
        result.vendor = probeResult.vendor;
        result.version = probeResult.version || null;
        result.confidence_score = probeResult.confidence || 0.9;
        result.auth_required = probeResult.auth_required || false;

        result.evidence.push(makeEvidence(DETECTION_METHODS.QUERY_RESPONSE, 'db-classifier',
          probeResult.confidence || 0.9,
          probeResult,
          { vendor: probeResult.vendor, version: probeResult.version }));
      }
    }

    if (mapping.http_probe) {
      const httpResult = await mapping.http_probe(ip, port);
      if (httpResult && httpResult.vendor) {
        result.vendor = httpResult.vendor;
        result.version = httpResult.version || null;
        result.confidence_score = Math.max(result.confidence_score, httpResult.confidence || 0.9);

        result.evidence.push(makeEvidence(DETECTION_METHODS.QUERY_RESPONSE, 'db-classifier',
          httpResult.confidence || 0.9,
          httpResult,
          { vendor: httpResult.vendor, version: httpResult.version }));
      }
    }

    if (result.confidence_score >= MIN_DATABASE_CONFIDENCE) {
      results.push(result);
    }
  }

  return results;
}

module.exports = {
  classifyDatabase,
  DB_PORT_MAP,
  probeRedis,
  probeElasticsearch,
  DETECTION_METHODS,
};
