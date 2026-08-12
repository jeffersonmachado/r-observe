'use strict';

/**
 * Gateway & Localhost Detector para Discovery Engine.
 *
 * Identifica:
 *  - Default gateway da(s) interface(s) local(is)
 *  - IPs locais do host (todas as interfaces)
 *
 * Usado para:
 *  - Classificar gateway com alta confiança (asset_type: gateway)
 *  - Separar host local do inventário de ativos externos
 *  - Evitar que o scanner trate a si mesmo como ativo descoberto
 *
 * Fontes:
 *  - /proc/net/route (Linux) — default gateway
 *  - /proc/net/fib_trie (Linux) — local IPs
 *  - ip route show default (Linux) — fallback
 *  - os.networkInterfaces() — Node.js built-in (cross-platform)
 */

const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * Lê o default gateway do /proc/net/route (Linux).
 * Formato: Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
 */
function readProcNetRoute() {
  try {
    const content = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = content.trim().split('\n').slice(1); // skip header

    const gateways = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 8) continue;

      const iface = parts[0];
      const destination = parts[1]; // hex, little-endian
      const gateway = parts[2];     // hex, little-endian

      // Destination 00000000 = default route
      if (destination !== '00000000') continue;

      // Converte hex LE para IP
      const gwHex = gateway;
      const gwIp = [
        parseInt(gwHex.slice(6, 8), 16),
        parseInt(gwHex.slice(4, 6), 16),
        parseInt(gwHex.slice(2, 4), 16),
        parseInt(gwHex.slice(0, 2), 16),
      ].join('.');

      if (gwIp !== '0.0.0.0') {
        gateways.push({ ip: gwIp, interface: iface, source: '/proc/net/route' });
      }
    }
    return gateways;
  } catch {
    return [];
  }
}

/**
 * Fallback: ip route show default
 */
function readIpRoute() {
  try {
    const output = execFileSync('ip', ['-4', 'route', 'show', 'default'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const gateways = [];
    for (const line of output.trim().split('\n').filter(Boolean)) {
      // "default via 192.168.0.1 dev eth0"
      const match = line.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)/);
      if (match) {
        gateways.push({ ip: match[1], interface: match[2], source: 'ip_route' });
      }
    }
    return gateways;
  } catch {
    return [];
  }
}

/**
 * Coleta todos os IPs locais de todas as interfaces (não-loopback).
 */
function getLocalIps() {
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const ips = new Set();

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.add(addr.address);
      }
    }
  }

  return Array.from(ips);
}

/**
 * Lê gateways e IPs locais de variáveis de ambiente.
 * Essencial quando o discovery roda em container Docker e não consegue
 * acessar /proc/net/route ou as interfaces de rede do host real.
 *
 * Variáveis:
 *   DISCOVERY_HOST_GATEWAY     — IP do default gateway (ex: 192.168.0.1)
 *   DISCOVERY_HOST_GATEWAYS    — gateways adicionais separados por vírgula
 *   DISCOVERY_HOST_LOCAL_IPS   — IPs locais separados por vírgula
 */
function readEnvOverrides() {
  const gateways = [];
  const gwEnv = process.env.DISCOVERY_HOST_GATEWAY;
  if (gwEnv && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(gwEnv.trim())) {
    gateways.push({ ip: gwEnv.trim(), interface: 'env', source: 'env:DISCOVERY_HOST_GATEWAY' });
  }
  const gwsEnv = process.env.DISCOVERY_HOST_GATEWAYS;
  if (gwsEnv) {
    for (const ip of gwsEnv.split(',').map(s => s.trim()).filter(Boolean)) {
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        gateways.push({ ip, interface: 'env', source: 'env:DISCOVERY_HOST_GATEWAYS' });
      }
    }
  }

  const localIps = [];
  const lipsEnv = process.env.DISCOVERY_HOST_LOCAL_IPS;
  if (lipsEnv) {
    for (const ip of lipsEnv.split(',').map(s => s.trim()).filter(Boolean)) {
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        localIps.push(ip);
      }
    }
  }

  return { gateways, localIps };
}

/**
 * Detecta default gateways e IPs locais.
 * Prioridade: OS detection + env var overrides (merge).
 *
 * @returns {{
 *   gateways: Array<{ ip: string, interface: string, source: string }>,
 *   local_ips: string[],
 *   is_gateway: (ip: string) => boolean,
 *   is_localhost: (ip: string) => boolean
 * }}
 */
function detectGateway() {
  // OS-level detection (funciona bem fora de container)
  let gateways = readProcNetRoute();
  if (!gateways.length) {
    gateways = readIpRoute();
  }

  let localIps = getLocalIps();

  // Env var overrides (merge — não substitui, complementa)
  const envOverrides = readEnvOverrides();

  // Adiciona gateways do env que não foram detectados pelo OS
  const osGatewayIps = new Set(gateways.map(g => g.ip));
  for (const g of envOverrides.gateways) {
    if (!osGatewayIps.has(g.ip)) {
      gateways.push(g);
    }
  }

  // Adiciona IPs locais do env que não foram detectados pelo OS
  const osLocalIpSet = new Set(localIps);
  for (const ip of envOverrides.localIps) {
    if (!osLocalIpSet.has(ip)) {
      localIps.push(ip);
    }
  }

  const gatewayIps = new Set(gateways.map((g) => g.ip));

  return {
    gateways,
    local_ips: localIps,
    gatewayIps,

    /**
     * Verifica se um IP é um default gateway.
     */
    isGateway(ip) {
      if (!ip) return false;
      return gatewayIps.has(ip);
    },

    /**
     * Verifica se um IP é o próprio host local.
     */
    isLocalhost(ip) {
      if (!ip) return false;
      return localIps.includes(ip) || ip === '127.0.0.1';
    },
  };
}

module.exports = {
  detectGateway,
  getLocalIps,
  readProcNetRoute,
  readIpRoute,
};
