'use strict';

// LLDP / CDP Active Probes para R-Observe Discovery (Enterprise).
// Envia pacotes LLDP (Link Layer Discovery Protocol) e CDP (Cisco Discovery Protocol)
// via raw socket ou lldpd para descobrir vizinhos de switch diretamente,
// sem depender de SNMP walk.
//
// LLDP: IEEE 802.1AB, multicast 01:80:c2:00:00:0e
// CDP:  Cisco proprietary, multicast 01:00:0c:cc:cc:cc
//
// Requer: lldpd instalado no host (lldpcli) ou CAP_NET_RAW.

const { execFile } = require('child_process');
const { promisify } = require('util');
const { log } = require('../utils/logger');

const execFileAsync = promisify(execFile);

// ── Via lldpd/lldpcli ────────────────────────────────────────────────────

async function discoverViaLldpd() {
  const neighbors = [];

  try {
    // lldpcli show neighbors details
    const { stdout } = await execFileAsync(
      'lldpcli', ['show', 'neighbors', 'details'], { timeout: 10000 }
    );

    let current = null;
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();

      // Novo vizinho: "Interface: eth0, via: LLDP"
      const ifMatch = trimmed.match(/^Interface:\s*(\S+),\s*via:\s*(LLDP|CDP)/i);
      if (ifMatch) {
        if (current) neighbors.push(current);
        current = {
          local_interface: ifMatch[1],
          protocol: ifMatch[2].toUpperCase(),
          chassis_id: null,
          chassis_name: null,
          chassis_description: null,
          port_id: null,
          port_description: null,
          system_name: null,
          system_description: null,
          management_addresses: [],
          vlan_id: null,
          capabilities: [],
        };
        continue;
      }

      if (!current) continue;

      const kvMatch = trimmed.match(/^(\w[\w\s]*?):\s*(.+)$/);
      if (!kvMatch) continue;

      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      switch (key) {
        case 'ChassisID': current.chassis_id = parseChassisId(value); break;
        case 'SysName': current.system_name = value; break;
        case 'SysDescr': current.system_description = value; break;
        case 'PortID': current.port_id = parsePortId(value); break;
        case 'PortDescr': current.port_description = value; break;
        case 'MgmtIP': current.management_addresses.push(value); break;
        case 'Capability':
          current.capabilities.push(value);
          break;
        case 'VLAN':
          current.vlan_id = parseInt(value, 10) || null;
          break;
        case 'Chassis':
          if (value.includes('Name:')) {
            current.chassis_name = value.split('Name:')[1]?.trim() || value;
          } else {
            current.chassis_description = value;
          }
          break;
      }
    }
    if (current) neighbors.push(current);

  } catch (e) {
    log('warn', 'LLDP/CDP discovery via lldpd failed', { err: e.message });
  }

  return neighbors;
}

function parseChassisId(value) {
  // "mac 00:11:22:33:44:55" → extrai MAC
  const macMatch = value.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
  if (macMatch) return { type: 'mac', value: macMatch[1].toLowerCase() };

  // "local hostname" ou "networkAddress 10.1.1.1"
  const ipMatch = value.match(/(\d+\.\d+\.\d+\.\d+)/);
  if (ipMatch) return { type: 'ip', value: ipMatch[1] };

  return { type: 'string', value };
}

function parsePortId(value) {
  const ifMatch = value.match(/ifname\s+(\S+)/);
  if (ifMatch) return { type: 'interface', value: ifMatch[1] };

  const macMatch = value.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
  if (macMatch) return { type: 'mac', value: macMatch[1].toLowerCase() };

  return { type: 'string', value };
}

// ── Via tcpdump + raw socket ─────────────────────────────────────────────

async function discoverViaTcpdump(durationSec = 15) {
  const neighbors = [];
  const duration = Math.max(1, Math.min(60, Number(durationSec) || 15));

  try {
    // Captura LLDP (ether proto 0x88cc) e CDP (ether proto 0x2000) em todas as interfaces
    const { stdout } = await execFileAsync('tcpdump', [
      '-i', 'any', '-nn', '-e', '-c', '50',
      'ether proto 0x88cc or ether proto 0x2000',
    ], { timeout: duration * 1000, killSignal: 'SIGTERM' });

    for (const line of stdout.split('\n')) {
      if (!line.trim() || line.includes('tcpdump:')) continue;

      const proto = line.includes('88cc') ? 'LLDP' : line.includes('2000') ? 'CDP' : 'unknown';

      // Extrai MACs: "aa:bb:cc:dd:ee:ff > 01:80:c2:00:00:0e"
      const macMatch = line.match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*>\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
      if (macMatch) {
        neighbors.push({
          protocol,
          source_mac: macMatch[1].toLowerCase(),
          local_interface: extractInterface(line),
          chassis_id: { type: 'mac', value: macMatch[1].toLowerCase() },
          source: 'tcpdump',
        });
      }
    }
  } catch (e) {
    log('warn', 'LLDP/CDP tcpdump capture failed', { err: e.message });
  }

  return neighbors;
}

function extractInterface(line) {
  const ifMatch = line.match(/^\d+:\d+:\d+\.\d+\s+\S+\s+\S+\s+\S+\s+(\S+)/);
  return ifMatch ? ifMatch[1] : null;
}

// ── Orquestrador ─────────────────────────────────────────────────────────

async function discoverLldpCdp() {
  let neighbors = [];

  // Metodo preferido: lldpd (preciso, estruturado)
  try {
    neighbors = await discoverViaLldpd();
  } catch (_) {}

  // Fallback: tcpdump em interfaces brutas
  if (neighbors.length === 0) {
    try {
      const tcpNeighbors = await discoverViaTcpdump(10);
      neighbors.push(...tcpNeighbors);
    } catch (_) {}
  }

  log('info', 'LLDP/CDP active discovery completed', {
    total: neighbors.length,
    lldp: neighbors.filter(n => n.protocol === 'LLDP').length,
    cdp: neighbors.filter(n => n.protocol === 'CDP').length,
  });

  return neighbors;
}

module.exports = { discoverLldpCdp, discoverViaLldpd, discoverViaTcpdump };
