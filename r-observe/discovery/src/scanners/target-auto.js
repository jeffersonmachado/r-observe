'use strict';

/**
 * Auto-discovery de alvos — deriva targets automaticamente de:
 * - Redes Docker (via inspect)
 * - Rotas do host (/proc/net/route)
 * - Subnets de containers existentes
 * - mDNS/SSDP hosts descobertos passivamente
 *
 * Zero configuração manual necessária.
 */

const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { log, info, debug, isDebug } = require('../utils/logger');

/**
 * Deriva subnets das redes Docker.
 * Requer /var/run/docker.sock.
 */
function deriveDockerSubnets() {
  try {
    const Docker = require('dockerode');
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    // Síncrono: docker inspect network (via child_process para evitar dependência async)
    const output = execSync('docker network inspect $(docker network ls -q) 2>/dev/null', {
      encoding: 'utf8', timeout: 5000,
    });
    const networks = JSON.parse(output);
    const subnets = [];
    for (const net of networks) {
      for (const ipam of net.IPAM?.Config || []) {
        if (ipam.Subnet) subnets.push(ipam.Subnet);
      }
    }
    return [...new Set(subnets)];
  } catch {
    return [];
  }
}

/**
 * Deriva subnets das rotas do host.
 * Lê /proc/net/route e extrai redes não-Docker.
 */
function deriveRouteSubnets() {
  const subnets = [];
  try {
    const content = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of content.trim().split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) continue;
      const iface = parts[0];
      const dest = parts[1]; // hex LE
      const mask = parts[7]; // hex LE

      // Pular interfaces Docker
      if (/^(docker|br-|veth)/.test(iface)) continue;

      const destIp = [
        parseInt(dest.slice(6, 8), 16), parseInt(dest.slice(4, 6), 16),
        parseInt(dest.slice(2, 4), 16), parseInt(dest.slice(0, 2), 16),
      ].join('.');

      const maskIp = [
        parseInt(mask.slice(6, 8), 16), parseInt(mask.slice(4, 6), 16),
        parseInt(mask.slice(2, 4), 16), parseInt(mask.slice(0, 2), 16),
      ].join('.');

      // Calcular prefix length da máscara
      const maskNum = maskIp.split('.').reduce((acc, n) => acc + (parseInt(n, 10) >>> 0).toString(2).split('1').length - 1, 0);
      if (maskNum > 0 && maskNum <= 32) {
        subnets.push(`${destIp}/${maskNum}`);
      }
    }
  } catch (_) {}
  return [...new Set(subnets)].filter(s => !s.startsWith('0.0.0.0'));
}

/**
 * Deriva targets de subnets próximas (expande /24 de IPs conhecidos).
 */
function deriveNeighborSubnets(knownIps) {
  const subnets = new Set();
  for (const ip of knownIps) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
    }
  }
  return [...subnets];
}

/**
 * Deriva subnets do host a partir da env var DISCOVERY_HOST_LOCAL_IPS.
 * Formato: CIDRs ou IPs separados por vírgula (ex: "192.168.0.0/24,10.0.0.1").
 * IPs sem máscara são expandidos para /24.
 * Essencial para containers Docker que não têm acesso às rotas/ARP do host.
 */
function deriveHostLocalSubnets() {
  const raw = process.env.DISCOVERY_HOST_LOCAL_IPS || '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      if (entry.includes('/')) return entry;
      // IP sem máscara: expande para /24
      const parts = entry.split('.');
      if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      }
      return entry;
    });
}

/**
 * Auto-discover targets de todas as fontes disponíveis.
 *
 * @param {string[]} knownIps - IPs já conhecidos (ARP, scan anterior)
 * @returns {{ targets: Array<{address: string, discovery_type: string}>, subnets: string[] }}
 */
function autoDiscoverTargets(knownIps = []) {
  const sources = {
    docker: deriveDockerSubnets(),
    routes: deriveRouteSubnets(),
    neighbors: deriveNeighborSubnets(knownIps),
    hostLocal: deriveHostLocalSubnets(),
  };

  const allSubnets = [...new Set([...sources.docker, ...sources.routes, ...sources.neighbors])];

  // Filtrar subnets muito grandes. Docker/multi-rede gera /16 e /20 que explodem
  // o scan. Default 256 hosts por subnet (mascara /24 ou menor).
  const maxSize = parseInt(process.env.DISCOVERY_AUTO_MAX_SUBNET_SIZE || '256', 10);
  const filtered = allSubnets.filter(cidr => {
    const mask = parseInt(cidr.split('/')[1], 10);
    if (isNaN(mask)) return false;
    // /32 = 1 host, /0 = toda internet → pular
    if (mask < 16) return false;
    if (mask > 30) return false;
    const size = Math.pow(2, 32 - mask);
    return size <= maxSize;
  });

  // Converter para targets
  const targets = [];
  for (const cidr of filtered) {
    // CIDRs se tornam targets para ping sweep
    targets.push({ address: cidr, discovery_type: 'cidr' });
  }

  if (isDebug()) {
    debug('auto-discover:targets', {
      sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.length])),
      filtered: filtered.length,
      max_size: maxSize,
    });
  }

  return { targets, subnets: filtered };
}

module.exports = { autoDiscoverTargets, deriveDockerSubnets, deriveRouteSubnets, deriveHostLocalSubnets };
