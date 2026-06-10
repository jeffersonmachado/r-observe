'use strict';

// ICMP Ping Sweep Scanner para R-Observe Discovery (Enterprise).
// Descobre hosts via ping ICMP, mesmo sem portas TCP abertas.
// Usa /bin/ping com timeout curto para varredura rapida de subnets.
// Suporta sweep de ranges inteiros (ex: 10.10.2.0/24) em paralelo.

const { exec } = require('child_process');
const { promisify } = require('util');
const { log } = require('../utils/logger');
const { isValidIPv4 } = require('./target-expansion');

const execAsync = promisify(exec);

const DEFAULT_COUNT = 1;
const DEFAULT_TIMEOUT_SEC = 1;
const MAX_PARALLEL = 50;

// Executa ping contra um unico host. Retorna { alive, latency_ms }.
async function pingHost(host, opts = {}) {
  const count = opts.count || DEFAULT_COUNT;
  const timeout = opts.timeout || DEFAULT_TIMEOUT_SEC;

  try {
    const start = Date.now();
    const { stdout } = await execAsync(
      `ping -c ${count} -W ${timeout} -n ${host}`,
      { timeout: (timeout + 2) * 1000 }
    );
    const elapsed = Date.now() - start;

    // Extrai latencia media do output
    const rttMatch = stdout.match(/rtt min\/avg\/max\/mdev = [\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+/);
    const latency = rttMatch ? parseFloat(rttMatch[1]) : elapsed;

    return { alive: true, latency_ms: Math.round(latency * 100) / 100, host };
  } catch {
    return { alive: false, host };
  }
}

// Ping sweep de uma lista de hosts com paralelismo controlado.
// Retorna array de hosts vivos.
async function pingSweep(hosts, opts = {}) {
  const maxParallel = opts.maxParallel || MAX_PARALLEL;
  const results = [];

  for (let i = 0; i < hosts.length; i += maxParallel) {
    const batch = hosts.slice(i, i + maxParallel);
    const batchResults = await Promise.all(batch.map(h => pingHost(h, opts)));
    results.push(...batchResults);
  }

  const alive = results.filter(r => r.alive);
  return alive;
}

// Descobre hosts em uma subnet via ping sweep.
// Ex: sweepSubnet('10.10.2.0/24') escaneia todos os 254 IPs.
async function sweepSubnet(cidr, opts = {}) {
  const hosts = expandSubnetToHosts(cidr);
  if (!hosts.length) return [];

  log('info', 'ICMP sweep started', { cidr, total: hosts.length });
  const start = Date.now();
  const alive = await pingSweep(hosts, opts);

  log('info', 'ICMP sweep completed', {
    cidr,
    total: hosts.length,
    alive: alive.length,
    elapsed_ms: Date.now() - start,
  });

  return alive;
}

// Expande um CIDR para lista de IPs individuais (exclui network e broadcast).
function expandSubnetToHosts(cidr) {
  const [ipStr, maskStr] = String(cidr).split('/');
  if (!maskStr) return [];

  const mask = parseInt(maskStr, 10);
  if (mask < 8 || mask > 30) return []; // /31 e /32 sao ponto a ponto, sem sweep

  const parts = ipStr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return [];

  const ipNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const netMask = ~((1 << (32 - mask)) - 1);
  const network = ipNum & netMask;
  const broadcast = network | ((1 << (32 - mask)) - 1);

  const hosts = [];
  for (let i = network + 1; i < broadcast; i++) {
    hosts.push(`${(i >> 24) & 0xff}.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`);
  }

  return hosts;
}

// Ping rapido em portas TCP (alternativa ao ICMP quando ping bloqueado).
// Usa TCP SYN-ish connect com timeout curto em porta comum (22, 80, 443).
async function tcpPingHost(host, port = 80, timeoutMs = 800) {
  const net = require('net');
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (alive) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ alive, host, method: 'tcp-ping', port });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Descobre hosts via TCP ping sweep (para redes onde ICMP e bloqueado).
async function tcpPingSweep(hosts, ports = [22, 80, 443], opts = {}) {
  const maxParallel = opts.maxParallel || MAX_PARALLEL;
  const alive = new Set();

  for (const port of ports) {
    for (let i = 0; i < hosts.length; i += maxParallel) {
      const batch = hosts.slice(i, i + maxParallel);
      const results = await Promise.all(batch.map(h => tcpPingHost(h, port, opts.timeout || 600)));
      for (const r of results) {
        if (r.alive) alive.add(r.host);
      }
    }
  }

  return Array.from(alive).map(host => ({ alive: true, host, method: 'tcp-ping' }));
}

module.exports = { pingHost, pingSweep, sweepSubnet, expandSubnetToHosts, tcpPingHost, tcpPingSweep };
