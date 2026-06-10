'use strict';

/**
 * Deep Protocol Prober — envia probes específicos para portas conhecidas
 * e extrai banners, versões e metadados que aumentam muito a confiança
 * da inferência.
 *
 * Diferente do TCP connect (binário: aberta/fechada), o deep probe
 * interage com o protocolo e retorna dados estruturados.
 *
 * Suporta: PostgreSQL, MySQL/MariaDB, Redis, HTTP, DNS, MongoDB, Elasticsearch
 */

const net = require('net');
const dgram = require('dgram');

const PROBE_TIMEOUT = 2500;

function udpQuery(host, port, payload, timeoutMs = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); resolve(null); }, timeoutMs);
    socket.on('message', (msg) => { clearTimeout(timer); socket.close(); resolve(msg); });
    socket.on('error', () => { clearTimeout(timer); socket.close(); resolve(null); });
    socket.send(payload, port, host);
  });
}

function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let data = '';
    const timer = setTimeout(() => { sock.destroy(); resolve(data || null); }, timeoutMs);
    sock.on('data', (chunk) => {
      data += chunk.toString('utf8', 0, 1024);
      if (data.length > 4096 || data.includes('\n')) {
        clearTimeout(timer);
        sock.destroy();
        resolve(data);
      }
    });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
    sock.on('connect', () => {}); // espera dados
    sock.connect(port, host);
  });
}

function tcpSend(host, port, payload, timeoutMs = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let data = '';
    const timer = setTimeout(() => { sock.destroy(); resolve(data || null); }, timeoutMs);
    sock.on('data', (chunk) => {
      data += chunk.toString('utf8', 0, 4096);
      if (data.length > 4096 || data.includes('\n')) {
        clearTimeout(timer);
        sock.destroy();
        resolve(data);
      }
    });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
    sock.on('connect', () => sock.write(payload));
    sock.connect(port, host);
  });
}

/**
 * PostgreSQL: envia StartupMessage e parseia versão.
 * O PostgreSQL responde com um ErrorResponse contendo a versão
 * mesmo sem autenticação válida, ou com AuthenticationOk.
 */
async function probePostgres(host, port = 5432) {
  // StartupMessage: protocol 3.0, user "observe", database "postgres"
  // Formato: int32 length + int32 protocol + key\0value\0... + \0
  const user = 'observe\0';
  const db = 'postgres\0';
  const extra = '\0'; // terminator
  const body = Buffer.from('user\0' + user + 'database\0' + db + extra, 'utf8');
  const len = 4 + 4 + body.length; // length field + protocol + body
  const buf = Buffer.alloc(len);
  buf.writeInt32BE(len, 0);         // total length
  buf.writeInt32BE(196608, 4);      // protocol 3.0 (3 << 16)
  body.copy(buf, 8);

  const resp = await tcpSend(host, port, buf);
  if (!resp || resp.length < 5) return null;

  const result = { product: 'PostgreSQL', technology: 'postgres', category: 'database' };

  // ErrorResponse (E) ou AuthenticationOk (R)
  const type = String.fromCharCode(resp.charCodeAt(0));
  if (type === 'R') result.auth_ok = true;

  // Extrai versão da mensagem de erro ou do handshake
  const text = resp.toString('utf8', 0, Math.min(resp.length, 1024));
  const verMatch = text.match(/PostgreSQL\s+([\d.]+)/i);
  if (verMatch) result.version = verMatch[1];

  return result;
}

/**
 * MySQL/MariaDB: lê o handshake inicial.
 * O servidor envia um pacote com versão no formato "5.5.5-10.11.6-MariaDB"
 */
async function probeMySQL(host, port = 3306) {
  const resp = await tcpProbe(host, port);
  if (!resp || resp.length < 10) return null;

  const result = { product: 'MySQL/MariaDB', technology: 'mysql', category: 'database' };

  // Handshake packet: protocol_version (1 byte) + server_version (null-terminated string)
  const nullIdx = resp.indexOf('\0', 1);
  if (nullIdx > 1) {
    const versionStr = resp.slice(1, nullIdx);
    result.version = versionStr;
    if (/mariadb/i.test(versionStr)) {
      result.product = 'MariaDB';
      result.technology = 'mariadb';
    } else {
      result.product = 'MySQL';
    }
  }

  return result;
}

/**
 * Redis: envia PING e espera +PONG
 */
async function probeRedis(host, port = 6379) {
  const resp = await tcpSend(host, port, '*1\r\n$4\r\nPING\r\n');
  if (!resp) return null;

  const result = { product: 'Redis', technology: 'redis', category: 'cache' };

  if (resp.startsWith('+PONG')) result.pong = true;

  // Tenta INFO para versão (opcional, pode ser bloqueado)
  const infoResp = await tcpSend(host, port, '*1\r\n$4\r\nINFO\r\n');
  if (infoResp) {
    const verMatch = infoResp.match(/redis_version:([\d.]+)/);
    if (verMatch) result.version = verMatch[1];
  }

  return result;
}

/**
 * HTTP: GET / e parseia Server header
 */
async function probeHTTP(host, port = 80, tls = false) {
  try {
    const proto = tls ? 'https' : 'http';
    const resp = await fetch(`${proto}://${host}:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      redirect: 'manual',
    });
    const server = resp.headers.get('server') || null;
    const result = { product: server || 'HTTP Service', technology: 'http', category: 'web' };
    if (server) {
      result.server = server;
      if (/nginx/i.test(server)) { result.product = 'Nginx'; result.technology = 'nginx'; }
      else if (/apache/i.test(server)) { result.product = 'Apache'; result.technology = 'apache'; }
      else if (/express/i.test(server)) { result.product = 'Express.js'; result.technology = 'nodejs'; }
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * DNS: consulta version.bind para detectar PowerDNS, BIND, etc.
 */
async function probeDNS(host, port = 53) {
  // Query: version.bind CHAOS TXT
  const query = Buffer.from([
    0x00, 0x00, // ID
    0x01, 0x00, // Flags: standard query
    0x00, 0x01, // QDCOUNT
    0x00, 0x00, // ANCOUNT
    0x00, 0x00, // NSCOUNT
    0x00, 0x00, // ARCOUNT
    // Question: version.bind CHAOS TXT
    0x07, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, // "version"
    0x04, 0x62, 0x69, 0x6e, 0x64, // "bind"
    0x00, // null
    0x00, 0x10, // TYPE=TXT
    0x00, 0x03, // CLASS=CHAOS
  ]);

  const resp = await udpQuery(host, port, query);
  if (!resp || resp.length < 12) return { product: 'DNS Service', technology: 'dns', category: 'dns' };

  const result = { product: 'DNS Service', technology: 'dns', category: 'dns' };

  // Parseia resposta DNS para versão
  const txtLen = resp.length;
  const str = resp.toString('utf8', 12, txtLen);
  const verMatch = str.match(/[Pp]ower[Dd][Nn][Ss]\s*[^\0]*/);
  if (verMatch) { result.product = 'PowerDNS'; result.technology = 'powerdns'; }
  else if (/bind/i.test(str)) { result.product = 'BIND'; result.technology = 'bind'; }
  else if (/dnsmasq/i.test(str)) { result.product = 'Dnsmasq'; result.technology = 'dnsmasq'; }

  return result;
}

/**
 * MongoDB: conecta e lê isMaster response
 */
async function probeMongoDB(host, port = 27017) {
  // MongoDB wire protocol: build isMaster command
  const resp = await tcpProbe(host, port);
  if (!resp || resp.length < 16) return null;

  const result = { product: 'MongoDB', technology: 'mongodb', category: 'database' };

  // Tenta extrair versão do handshake
  const verMatch = resp.toString('utf8').match(/(\d+\.\d+\.\d+)/);
  if (verMatch) result.version = verMatch[1];

  return result;
}

/**
 * Elasticsearch: GET / e parseia versão
 */
async function probeElasticsearch(host, port = 9200) {
  try {
    const resp = await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    const json = await resp.json().catch(() => null);
    if (json?.version?.number) {
      return {
        product: 'Elasticsearch',
        technology: 'elasticsearch',
        category: 'search',
        version: json.version.number,
        cluster_name: json.cluster_name || null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe dispatcher — chama o probe certo para cada porta.
 * Retorna null se nenhum probe aplicável ou se falhar.
 */
async function deepProbe(host, port) {
  switch (port) {
    case 5432: return probePostgres(host, port);
    case 3306: return probeMySQL(host, port);
    case 6379: return probeRedis(host, port);
    case 80:   return probeHTTP(host, port, false);
    case 443:  return probeHTTP(host, port, true);
    case 8080: return probeHTTP(host, port, false);
    case 3000: return probeHTTP(host, port, false);
    case 53:   return probeDNS(host, port);
    case 27017: return probeMongoDB(host, port);
    case 9200: return probeElasticsearch(host, port);
    default: return null;
  }
}

/**
 * Converte resultado de deep probe em evidência para o inference engine.
 */
function probeToEvidence(host, port, probeResult) {
  if (!probeResult) return null;
  return {
    evidence_type: 'deep_probe',
    evidence_source: `probe-${probeResult.technology || 'unknown'}`,
    confidence: probeResult.version ? 0.88 : 0.72,
    raw_data: { host, port, ...probeResult },
    normalized_data: {
      technology: probeResult.technology,
      product: probeResult.product,
      category: probeResult.category,
      version: probeResult.version || null,
      server: probeResult.server || null,
    },
  };
}

module.exports = { deepProbe, probeToEvidence };
