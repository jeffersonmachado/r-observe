'use strict';

// IPv6 Scanner + Target Expansion para R-Observe Discovery (Enterprise).
// Suporte completo a IPv6: ping6, expansao de prefixos, reverse DNS,
// TCP connect via IPv6 e integracao com o pipeline de descoberta.

const { execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const dns = require('dns').promises;
const { log } = require('../utils/logger');

const execFileAsync = promisify(execFile);

// Valida endereco IPv6.
function isValidIPv6(ip) {
  if (typeof ip !== 'string') return false;
  // IPv6 com bracket (ex: [::1])
  const cleaned = ip.replace(/^\[|\]$/g, '');
  if (cleaned === '::1') return true;
  if (net.isIPv6) return net.isIPv6(cleaned);
  // Fallback: regex IPv6
  return /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(cleaned) ||
         /^([0-9a-fA-F]{0,4}:){2,6}([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(cleaned);
}

// Ping IPv6 (ping6).
async function ping6Host(host, opts = {}) {
  if (!isValidIPv6(host)) return { alive: false, host, family: 6 };
  const count = Math.max(1, Math.min(5, Number(opts.count) || 1));
  const timeout = Math.max(1, Math.min(10, Number(opts.timeout) || 1));

  try {
    const start = Date.now();
    const { stdout } = await execFileAsync(
      'ping6', ['-c', String(count), '-W', String(timeout), '-n', host],
      { timeout: (timeout + 2) * 1000 }
    );
    const elapsed = Date.now() - start;
    const rttMatch = stdout.match(/rtt min\/avg\/max\/mdev = [\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+/);
    const latency = rttMatch ? parseFloat(rttMatch[1]) : elapsed;
    return { alive: true, latency_ms: Math.round(latency * 100) / 100, host, family: 6 };
  } catch {
    return { alive: false, host, family: 6 };
  }
}

// TCP connect IPv6.
function tcpConnect6(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Ping sweep IPv6 de uma lista de hosts.
async function ping6Sweep(hosts, opts = {}) {
  const maxParallel = opts.maxParallel || 30;
  const results = [];

  for (let i = 0; i < hosts.length; i += maxParallel) {
    const batch = hosts.slice(i, i + maxParallel);
    const batchResults = await Promise.all(batch.map(h => ping6Host(h, opts)));
    results.push(...batchResults);
  }

  return results.filter(r => r.alive);
}

// Expande prefixo IPv6 para hosts individuais (apenas /120 a /126).
// Prefixos maiores geram muitos hosts e nao sao varridos.
function expandIPv6Prefix(cidr) {
  const [netStr, maskStr] = String(cidr).split('/');
  const mask = parseInt(maskStr, 10);

  if (mask < 120 || mask > 126) {
    // Prefixos /64 ou menores sao grandes demais para sweep
    // Retorna apenas o gateway e o proprio IP se conhecido
    return [];
  }

  // Expande os ultimos 128-mask bits
  const parts = expandIPv6(netStr);
  if (!parts) return [];

  const hostBits = 128 - mask;
  const networkBase = partsToBigInt(parts);
  const maxHosts = Math.min(Math.pow(2, hostBits) - 2, 64); // max 64 hosts

  const hosts = [];
  for (let i = 1; i <= maxHosts; i++) {
    hosts.push(bigIntToIPv6(networkBase + BigInt(i)));
  }

  return hosts;
}

// Expande IPv6 abreviado para array de 8 partes.
function expandIPv6(ip) {
  const cleaned = ip.replace(/^\[|\]$/g, '').trim();

  // IPv4-mapped: ::ffff:1.2.3.4
  if (cleaned.includes('.')) {
    const m = cleaned.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return null; // trata como IPv4
  }

  if (cleaned === '::1') return [0, 0, 0, 0, 0, 0, 0, 1];

  const parts = cleaned.split(':');
  const expanded = [];
  let doubleColon = false;

  for (const part of parts) {
    if (part === '') {
      if (doubleColon) { expanded.push(0); continue; }
      doubleColon = true;
      const missing = 8 - parts.filter(p => p !== '').length;
      for (let j = 0; j < missing; j++) expanded.push(0);
    } else {
      expanded.push(parseInt(part, 16) || 0);
    }
  }

  while (expanded.length < 8) expanded.push(0);
  return expanded.slice(0, 8);
}

function partsToBigInt(parts) {
  let result = BigInt(0);
  for (const part of parts) {
    result = (result << BigInt(16)) | BigInt(part);
  }
  return result;
}

function bigIntToIPv6(num) {
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.unshift(Number(num & BigInt(0xffff)));
    num >>= BigInt(16);
  }
  return parts.map(p => p.toString(16)).join(':');
}

// Reverse DNS IPv6.
async function reverseDns6(ip) {
  try {
    // Converte para formato .ip6.arpa
    const parts = expandIPv6(ip);
    if (!parts) return null;
    const nibbles = [];
    for (const part of parts) {
      nibbles.push((part & 0xf).toString(16));
      nibbles.push(((part >> 4) & 0xf).toString(16));
      nibbles.push(((part >> 8) & 0xf).toString(16));
      nibbles.push(((part >> 12) & 0xf).toString(16));
    }
    const ptr = nibbles.reverse().join('.') + '.ip6.arpa';
    const names = await dns.resolvePtr(ptr).catch(() => []);
    return names[0] || null;
  } catch {
    return null;
  }
}

// Descobre hosts IPv6 via NDP (Neighbor Discovery Protocol).
// Equivalente ao ARP para IPv6: ip -6 neigh.
async function discoverNdpTable() {
  const entries = [];
  try {
    const { stdout } = await execFileAsync('ip', ['-6', 'neigh', 'show'], { timeout: 5000 });
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const ip = parts[0];
      const mac = parts.find(p => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p)) || null;
      const state = parts.includes('REACHABLE') ? 'reachable' :
                    parts.includes('STALE') ? 'stale' :
                    parts.includes('DELAY') ? 'delay' : 'unknown';
      if (isValidIPv6(ip) && ip !== '::1' && !ip.startsWith('fe80:')) {
        entries.push({ ip, mac, state, family: 6 });
      }
    }
  } catch {
    log('warn', 'NDP table discovery failed');
  }
  return entries;
}

// Descobre subnets IPv6 locais (interfaces + rotas).
async function discoverIPv6Subnets() {
  const subnets = [];

  // Interfaces
  try {
    const { stdout } = await execFileAsync('ip', ['-6', '-o', 'addr', 'show'], { timeout: 5000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/inet6\s+([0-9a-f:]+\/\d+)/i);
      if (!m) continue;
      const cidr = m[1];
      if (cidr.startsWith('::1/') || cidr.startsWith('fe80:/')) continue;
      subnets.push({ cidr, source: 'local-interface', family: 6 });
    }
  } catch (_) {}

  // Rotas
  try {
    const { stdout } = await execFileAsync('ip', ['-6', 'route', 'show'], { timeout: 5000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/([0-9a-f:]+\/\d+)/i);
      if (!m) continue;
      const cidr = m[1];
      if (cidr.startsWith('fe80:/') || cidr === '::/0') continue;
      subnets.push({ cidr, source: 'route-table', family: 6 });
    }
  } catch (_) {}

  return subnets;
}

// Scan ativo IPv6: ping6 + TCP connect nas portas well-known.
async function activeScan6(host, ports = [22, 80, 443, 53, 993, 8080, 9090, 3000]) {
  const ping = await ping6Host(host, { count: 1, timeout: 2 });
  if (!ping.alive) return { host, alive: false, family: 6 };

  const openPorts = [];
  for (const port of ports) {
    const ok = await tcpConnect6(host, port, 1200);
    if (ok) openPorts.push(port);
  }

  const hostname = await reverseDns6(host);

  return {
    host,
    alive: true,
    family: 6,
    hostname,
    open_ports: openPorts,
    latency_ms: ping.latency_ms,
  };
}

module.exports = {
  isValidIPv6,
  ping6Host,
  ping6Sweep,
  tcpConnect6,
  expandIPv6Prefix,
  expandIPv6,
  reverseDns6,
  discoverNdpTable,
  discoverIPv6Subnets,
  activeScan6,
};
