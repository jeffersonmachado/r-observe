'use strict';

// Subnet Auto-Discovery para R-Observe Discovery (Enterprise).
// Descobre subnets adjacentes automaticamente a partir de:
// 1. Interfaces de rede locais (ip addr / ifconfig)
// 2. Tabela de roteamento (ip route)
// 3. Vizinhos ARP existentes (agrupamento por prefixo)
// 4. SNMP CDP/LLDP neighbors de switches gerenciados

const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const { log } = require('../utils/logger');
const { isValidIPv4 } = require('./target-expansion');

const execFileAsync = promisify(execFile);

// Extrai subnets das interfaces de rede locais.
async function discoverLocalSubnets() {
  const subnets = [];
  const seen = new Set();

  try {
    // Tenta ip addr primeiro (Linux moderno)
    const { stdout } = await execFileAsync('ip', ['-o', '-4', 'addr', 'show'], { timeout: 5000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
      if (!m) continue;
      const cidr = `${m[1]}/${m[2]}`;
      if (!seen.has(cidr) && !m[1].startsWith('127.')) {
        seen.add(cidr);
        subnets.push({
          cidr,
          source: 'local-interface',
          gateway: null,
        });
      }
    }
  } catch {
    // Fallback: ifconfig (BSD, macOS, Alpine antigo)
    try {
      const interfaces = os.networkInterfaces();
      for (const [, addrs] of Object.entries(interfaces)) {
        for (const addr of (addrs || [])) {
          if (addr.family !== 'IPv4' || addr.internal) continue;
          const mask = addr.netmask;
          if (!mask) continue;
          const prefix = netmaskToPrefix(mask);
          const cidr = `${addr.address}/${prefix}`;
          if (!seen.has(cidr)) {
            seen.add(cidr);
            subnets.push({ cidr, source: 'local-interface', gateway: null });
          }
        }
      }
    } catch (e) {
      log('warn', 'Local subnet discovery failed', { err: e.message });
    }
  }

  return subnets;
}

// Converte netmask (ex: 255.255.255.0) para prefixo (24).
function netmaskToPrefix(mask) {
  const parts = String(mask).split('.').map(Number);
  let prefix = 0;
  for (const part of parts) {
    let bits = part;
    while (bits) { prefix += bits & 1; bits >>= 1; }
  }
  return prefix;
}

// Descobre subnets via tabela de roteamento.
async function discoverRouteSubnets() {
  const subnets = [];
  const seen = new Set();

  try {
    const { stdout } = await execFileAsync('ip', ['-4', 'route', 'show'], { timeout: 5000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/(\d+\.\d+\.\d+\.\d+\/\d+)/);
      if (!m) continue;
      const cidr = m[1];
      const gwMatch = line.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
      if (!seen.has(cidr) && !cidr.startsWith('0.0.0.0') && !cidr.startsWith('127.')) {
        seen.add(cidr);
        subnets.push({
          cidr,
          source: 'route-table',
          gateway: gwMatch ? gwMatch[1] : null,
        });
      }
    }
  } catch (e) {
    log('warn', 'Route subnet discovery failed', { err: e.message });
  }

  return subnets;
}

// Agrupa IPs de assets conhecidos em subnets sugeridas (/24 por padrao).
function suggestSubnetsFromAssets(assets, prefix = 24) {
  const subnets = new Map();

  for (const asset of assets) {
    const ip = asset.primary_ip;
    if (!ip || !isValidIPv4(ip)) continue;
    if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

    const parts = ip.split('.').map(Number);
    const network = parts.slice(0, prefix === 24 ? 3 : 2).join('.') + '.0';
    const cidr = `${network}/${prefix}`;

    if (!subnets.has(cidr)) {
      subnets.set(cidr, { cidr, count: 0, sample_ips: [] });
    }
    const entry = subnets.get(cidr);
    entry.count++;
    if (entry.sample_ips.length < 3) entry.sample_ips.push(ip);
  }

  return Array.from(subnets.values())
    .filter(s => s.count >= 2) // pelo menos 2 assets conhecidos na subnet
    .map(s => ({
      cidr: s.cidr,
      source: 'asset-clustering',
      asset_count: s.count,
      sample_ips: s.sample_ips,
    }));
}

// Agrupamento por vizinhos SNMP LLDP/CDP (subnets aprendidas de switches).
function suggestSubnetsFromNeighbors(assets) {
  const subnets = new Map();

  for (const asset of assets) {
    const neighbors = asset.snmp_neighbors || asset.scan_result?.snmp_neighbors || [];
    for (const neighbor of neighbors) {
      const name = typeof neighbor === 'string' ? neighbor : neighbor.name || '';
      const ipMatch = name.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (!ipMatch) continue;
      const ip = ipMatch[1];
      if (!isValidIPv4(ip)) continue;
      if (ip.startsWith('127.')) continue;

      const parts = ip.split('.');
      const network = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
      if (!subnets.has(network)) {
        subnets.set(network, { cidr: network, source: 'snmp-lldp-neighbor', hosts: [] });
      }
      subnets.get(network).hosts.push(ip);
    }
  }

  return Array.from(subnets.values());
}

// Orquestrador: descobre todas as subnets automaticamente.
async function discoverAllSubnets(knownAssets = []) {
  const results = {
    local_interfaces: [],
    route_table: [],
    asset_clusters: [],
    neighbor_learned: [],
    merged: [],
  };

  // 1. Interfaces locais
  results.local_interfaces = await discoverLocalSubnets();

  // 2. Tabela de roteamento
  results.route_table = await discoverRouteSubnets();

  // 3. Agrupamento de assets conhecidos
  if (knownAssets.length > 0) {
    results.asset_clusters = suggestSubnetsFromAssets(knownAssets);
    results.neighbor_learned = suggestSubnetsFromNeighbors(knownAssets);
  }

  // 4. Merge deduplicado
  const merged = new Map();
  for (const group of [results.local_interfaces, results.route_table, results.asset_clusters, results.neighbor_learned]) {
    for (const item of group) {
      if (!merged.has(item.cidr)) {
        merged.set(item.cidr, item);
      }
    }
  }
  results.merged = Array.from(merged.values());

  log('info', 'Subnet auto-discovery completed', {
    total: results.merged.length,
    sources: {
      local: results.local_interfaces.length,
      route: results.route_table.length,
      cluster: results.asset_clusters.length,
      neighbor: results.neighbor_learned.length,
    },
  });

  return results;
}

module.exports = { discoverLocalSubnets, discoverRouteSubnets, suggestSubnetsFromAssets, suggestSubnetsFromNeighbors, discoverAllSubnets };
