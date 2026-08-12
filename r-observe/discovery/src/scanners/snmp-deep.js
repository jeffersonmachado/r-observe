'use strict';

/**
 * SNMP Deep Discovery Engine — coleta completa de SNMP:
 *   - System (sysObjectID → classificação precisa)
 *   - Interfaces (ifTable + ifXTable) com métricas
 *   - VLANs (Q-BRIDGE-MIB)
 *   - ARP table (ipNetToMedia)
 *   - Sensores de hardware (Entity-MIB)
 *   - CPU/Memória/Storage (UCD-SNMP-MIB + HOST-RESOURCES-MIB)
 *   - Vizinhos CDP/LLDP via SNMP
 *   - Wireless (802.11 + vendor-specific)
 *
 * Substitui o snmp-discovery.js antigo (que era só snmpget básico).
 */

const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { snmpWalkParsed, snmpGet, snmpWalkIndexed, cleanSnmpValue } = require('../mibs/snmp-walk');
const { OIDS, resolveSysObjectID } = require('../mibs/snmp-oids');
const { log } = require('../utils/logger');

const REACHABLE_TIMEOUT = 3000;

/**
 * Testa se o host responde SNMP (snmpget no sysDescr).
 */
async function probeSnmp(host, community) {
  const result = await snmpGet(host, OIDS.system.sysDescr, {
    community,
    timeout: REACHABLE_TIMEOUT,
  });
  return result !== null && result.length > 0;
}

// ── Parsers de tabela ──────────────────────────────────────────────────────

function parseIfType(raw) {
  const map = {
    '6': 'ethernetCsmacd', '7': 'ethernet', '23': 'ppp', '24': 'softwareLoopback',
    '53': 'propVirtual', '117': 'gigabitEthernet', '135': 'l2vlan', '136': 'l3ipvlan',
    '161': 'ieee80211', '166': 'mpls', '209': 'bridge', '258': 'opticalChannel',
  };
  return map[String(raw)] || `ifType(${raw})` || null;
}

function parseOperStatus(raw) {
  const map = { '1': 'up', '2': 'down', '3': 'testing', '4': 'unknown',
                '5': 'dormant', '6': 'notPresent', '7': 'lowerLayerDown' };
  return map[String(raw)] || raw || null;
}

function parseAdminStatus(raw) {
  const map = { '1': 'up', '2': 'down', '3': 'testing' };
  return map[String(raw)] || raw || null;
}

function match(oid, prefix) {
  return oid.startsWith(prefix);
}

/**
 * Constroi tabela de interfaces combinando ifTable + ifXTable.
 */
function buildInterfaceTable(ifRows, ifxRows) {
  const ifIdx = {};

  for (const r of ifRows) {
    if (!r.index) continue;
    if (!ifIdx[r.index]) ifIdx[r.index] = { index: Number(r.index) };

    if (match(r.oid, OIDS.interfaces.ifDescr))       ifIdx[r.index].description = r.value;
    if (match(r.oid, OIDS.interfaces.ifType))        ifIdx[r.index].type = parseIfType(r.value);
    if (match(r.oid, OIDS.interfaces.ifMtu))         ifIdx[r.index].mtu = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifSpeed))       ifIdx[r.index].speed_bps = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifPhysAddress)) ifIdx[r.index].mac = r.value;
    if (match(r.oid, OIDS.interfaces.ifAdminStatus)) ifIdx[r.index].admin_status = parseAdminStatus(r.value);
    if (match(r.oid, OIDS.interfaces.ifOperStatus))  ifIdx[r.index].oper_status = parseOperStatus(r.value);
    if (match(r.oid, OIDS.interfaces.ifInOctets))    ifIdx[r.index].in_octets = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifInUcastPkts)) ifIdx[r.index].in_ucast = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifInErrors))    ifIdx[r.index].in_errors = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifInDiscards))  ifIdx[r.index].in_discards = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifOutOctets))   ifIdx[r.index].out_octets = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifOutUcastPkts))ifIdx[r.index].out_ucast = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifOutErrors))   ifIdx[r.index].out_errors = parseInt(r.value) || null;
    if (match(r.oid, OIDS.interfaces.ifOutDiscards)) ifIdx[r.index].out_discards = parseInt(r.value) || null;
  }

  for (const r of ifxRows) {
    if (!r.index) continue;
    if (!ifIdx[r.index]) ifIdx[r.index] = { index: Number(r.index) };

    if (match(r.oid, OIDS.ifXTable.ifName))         ifIdx[r.index].name = r.value;
    if (match(r.oid, OIDS.ifXTable.ifAlias))        ifIdx[r.index].alias = r.value;
    if (match(r.oid, OIDS.ifXTable.ifHighSpeed))    ifIdx[r.index].high_speed_mbps = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifHCInOctets))   ifIdx[r.index].hc_in_octets = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifHCOutOctets))  ifIdx[r.index].hc_out_octets = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifHCInUcastPkts)) ifIdx[r.index].hc_in_ucast = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifHCOutUcastPkts)) ifIdx[r.index].hc_out_ucast = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifInMulticastPkts)) ifIdx[r.index].in_multicast = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifInBroadcastPkts)) ifIdx[r.index].in_broadcast = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifOutMulticastPkts)) ifIdx[r.index].out_multicast = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ifXTable.ifOutBroadcastPkts)) ifIdx[r.index].out_broadcast = parseInt(r.value) || null;
  }

  return Object.values(ifIdx).sort((a, b) => a.index - b.index);
}

/**
 * Descobre VLANs via Q-BRIDGE-MIB.
 */
function parseVlans(rows) {
  const vlans = {};
  for (const r of rows) {
    if (!r.index) continue;
    if (!vlans[r.index]) vlans[r.index] = { vlan_id: Number(r.index) };
    if (match(r.oid, OIDS.vlan.dot1qVlanStaticName)) vlans[r.index].name = r.value;
  }
  return Object.values(vlans).filter(v => v.name).sort((a, b) => a.vlan_id - b.vlan_id);
}

/**
 * Extrai entidades físicas (Entity-MIB): serial, model, hardware.
 */
function parseEntityTable(rows) {
  const entities = {};
  for (const r of rows) {
    if (!r.index) continue;
    if (!entities[r.index]) entities[r.index] = { entity_index: Number(r.index) };

    if (match(r.oid, OIDS.entity.entPhysicalDescr))      entities[r.index].description = r.value;
    if (match(r.oid, OIDS.entity.entPhysicalName))        entities[r.index].name = r.value;
    if (match(r.oid, OIDS.entity.entPhysicalClass))       entities[r.index].class = r.value;
    if (match(r.oid, OIDS.entity.entPhysicalSerialNum))   entities[r.index].serial = r.value;
    if (match(r.oid, OIDS.entity.entPhysicalModelName))   entities[r.index].model = r.value;
    if (match(r.oid, OIDS.entity.entPhysicalHardwareRev)) entities[r.index].hw_rev = r.value;
    if (match(r.oid, OIDS.entity.entPhysicalFirmwareRev)) entities[r.index].fw_rev = r.value;
    if (match(r.oid, OIDS.entity.entPhysicalSoftwareRev)) entities[r.index].sw_rev = r.value;
  }

  const chassis = Object.values(entities).find(e => String(e.class) === '3'); // chassis
  const result = {
    entities: Object.values(entities).sort((a, b) => a.entity_index - b.entity_index),
    chassis_serial: chassis?.serial || null,
    chassis_model: chassis?.model || null,
    chassis_hw_rev: chassis?.hw_rev || null,
    chassis_fw_rev: chassis?.fw_rev || null,
  };

  // Fallback: primeiro serial/model encontrado
  if (!result.chassis_serial) {
    for (const e of result.entities) {
      if (e.serial) { result.chassis_serial = e.serial; break; }
    }
  }
  if (!result.chassis_model) {
    for (const e of result.entities) {
      if (e.model) { result.chassis_model = e.model; break; }
    }
  }

  return result;
}

/**
 * Extrai CPU via UCD-SNMP-MIB.
 */
function parseCpu(rows) {
  const cpu = { cores: 0, load: [], load_1min: null, load_5min: null, load_15min: null };
  for (const r of rows) {
    if (match(r.oid, OIDS.ucd.ssCpuSystem)) cpu.system_pct = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.ssCpuUser))   cpu.user_pct = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.ssCpuIdle))   cpu.idle_pct = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.ssCpuRawWait)) cpu.wait_pct = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.laLoadInt)) {
      if (r.index === '1') cpu.load_1min = parseFloat(r.value) || null;
      if (r.index === '2') cpu.load_5min = parseFloat(r.value) || null;
      if (r.index === '3') cpu.load_15min = parseFloat(r.value) || null;
    }
  }

  // Conta cores via hrProcessorLoad se disponível (coletado separadamente)
  return cpu;
}

/**
 * Extrai memória via UCD-SNMP-MIB.
 */
function parseMemory(rows) {
  const mem = {};
  for (const r of rows) {
    if (match(r.oid, OIDS.ucd.memTotalReal))  mem.total_kb = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.memAvailReal))  mem.avail_kb = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.memTotalSwap))  mem.swap_total_kb = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.memAvailSwap))  mem.swap_avail_kb = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.memBuffer))     mem.buffer_kb = parseInt(r.value) || null;
    if (match(r.oid, OIDS.ucd.memCached))     mem.cached_kb = parseInt(r.value) || null;
  }
  return mem;
}

/**
 * Extrai storage via HOST-RESOURCES-MIB.
 */
function parseStorage(rows) {
  const storage = [];
  const byIndex = {};
  for (const r of rows) {
    if (!r.index) continue;
    if (!byIndex[r.index]) byIndex[r.index] = {};

    if (match(r.oid, OIDS.host.hrStorageDescr)) byIndex[r.index].description = r.value;
    if (match(r.oid, OIDS.host.hrStorageAllocationUnits)) byIndex[r.index].allocation_units = parseInt(r.value) || null;
    if (match(r.oid, OIDS.host.hrStorageSize)) byIndex[r.index].size = parseInt(r.value) || null;
    if (match(r.oid, OIDS.host.hrStorageUsed)) byIndex[r.index].used = parseInt(r.value) || null;
  }

  for (const [idx, s] of Object.entries(byIndex)) {
    const units = s.allocation_units || 1;
    const totalBytes = (s.size || 0) * units;
    const usedBytes = (s.used || 0) * units;
    storage.push({
      index: Number(idx),
      description: s.description || `storage-${idx}`,
      total_bytes: totalBytes,
      used_bytes: usedBytes,
      avail_bytes: totalBytes - usedBytes,
      used_pct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : null,
    });
  }

  return storage.sort((a, b) => a.index - b.index);
}

/**
 * Extrai tabela ARP.
 */
function parseArpTable(rows) {
  const arp = {};
  for (const r of rows) {
    if (!r.index) continue;
    const key = `${r.index}`;
    if (!arp[key]) arp[key] = {};

    if (match(r.oid, OIDS.ip.ipNetToMediaPhysAddress)) arp[key].mac = r.value;
    if (match(r.oid, OIDS.ip.ipNetToMediaNetAddress))  arp[key].ip = r.value;
    if (match(r.oid, OIDS.ip.ipNetToMediaType))        arp[key].type = r.value;
    if (match(r.oid, OIDS.ip.ipNetToMediaIfIndex))     arp[key].if_index = parseInt(r.value) || null;
  }
  return Object.values(arp).filter(a => a.ip && a.mac);
}

/**
 * Extrai vizinhos LLDP (via SNMP).
 */
function parseLldpNeighbors(rows) {
  const neighbors = {};
  for (const r of rows) {
    if (!r.index) continue;
    if (!neighbors[r.index]) neighbors[r.index] = {};
    neighbors[r.index].remote = r.value;
  }
  return Object.values(neighbors).filter(n => n.remote);
}

/**
 * Extrai dados wireless (802.11 + vendor).
 */
function parseWireless(rows) {
  const wlan = {};
  for (const r of rows) {
    if (match(r.oid, OIDS.wireless.dot11DesiredSSID) && !wlan.ssid) wlan.ssid = r.value;
    if (match(r.oid, OIDS.wireless.dot11CurrentChannel) && !wlan.channel) wlan.channel = parseInt(r.value) || null;
    if (match(r.oid, OIDS.wireless.dot11AssociatedStationCount) && !wlan.client_count) wlan.client_count = parseInt(r.value) || null;
    // Unifi
    if (match(r.oid, OIDS.wireless.unifiApSystemModel) && !wlan.model) wlan.model = r.value;
    if (match(r.oid, OIDS.wireless.unifiRadioChannel) && !wlan.channel) wlan.channel = parseInt(r.value) || null;
    if (match(r.oid, OIDS.wireless.unifiStaCount) && !wlan.client_count) wlan.client_count = parseInt(r.value) || null;
    // MikroTik
    if (match(r.oid, OIDS.wireless.mtWirelessSSID) && !wlan.ssid) wlan.ssid = r.value;
    if (match(r.oid, OIDS.wireless.mtWirelessChannel) && !wlan.channel) wlan.channel = parseInt(r.value) || null;
    if (match(r.oid, OIDS.wireless.mtWirelessClientCount) && !wlan.client_count) wlan.client_count = parseInt(r.value) || null;
  }
  return Object.keys(wlan).length > 0 ? wlan : null;
}

// ── Engine Principal ───────────────────────────────────────────────────────

/**
 * Executa discovery SNMP completo em um host.
 *
 * @param {string} host - IP ou hostname
 * @param {object} opts - { community, profile }
 * @returns {object} resultado completo
 */
async function snmpDeepDiscover(host, opts = {}) {
  const community = opts.community || process.env.SNMP_COMMUNITY || 'public';
  const walkOpts = { community };

  const result = {
    host,
    reachable: false,
    auth_failure: false,

    // System
    sysDescr: null,
    sysObjectID: null,
    sysName: null,
    sysUptime: null,
    sysContact: null,
    sysLocation: null,
    sysServices: null,

    // Classificação precisa via sysObjectID
    classification: null,

    // Interfaces
    interfaces: [],
    interface_count: 0,

    // VLANs
    vlans: [],

    // ARP Table
    arp_table: [],

    // Entity / Hardware
    entity: null,
    serial: null,
    model: null,

    // CPU / Memory / Storage
    cpu: null,
    memory: null,
    storage: [],

    // Vizinhos
    lldp_neighbors: [],

    // Wireless
    wireless: null,

    // Timestamps
    collected_at: new Date().toISOString(),
    errors: [],
  };

  try {
    // 1. Probe rápido
    const sysValues = await snmpGet(host, [
      OIDS.system.sysDescr,
      OIDS.system.sysObjectID,
      OIDS.system.sysName,
      OIDS.system.sysUpTime,
      OIDS.system.sysContact,
      OIDS.system.sysLocation,
      OIDS.system.sysServices,
    ], { community, timeout: 5000 });

    if (Array.isArray(sysValues)) {
      result.sysDescr    = sysValues[0] || null;
      result.sysObjectID = sysValues[1] || null;
      result.sysName     = sysValues[2] || null;
      result.sysUptime   = sysValues[3] || null;
      result.sysContact  = sysValues[4] || null;
      result.sysLocation = sysValues[5] || null;
      result.sysServices = sysValues[6] || null;
    } else {
      // Falhou completamente
      result.errors.push('snmp_unreachable');
      return result;
    }

    // Resolve sysObjectID numericamente (snmpget -Oqv pode retornar MIB name)
    if (result.sysObjectID && !result.sysObjectID.startsWith('.')) {
      try {
        const { stdout } = await execFileAsync('snmpget', [
          '-v2c', '-c', String(community), '-t', '5', '-r', '1', '-On',
          host, OIDS.system.sysObjectID,
        ], { timeout: 10000 });
        const match = stdout.match(/=\s*OID:\s*(\.\S+)/);
        if (match) result.sysObjectID = match[1];
      } catch (_) { /* mantém o valor original */ }
    }

    result.reachable = true;

    // Classificação via sysObjectID (gap 1 resolvido!)
    if (result.sysObjectID) {
      result.classification = resolveSysObjectID(result.sysObjectID);
    }

    // 2. Interfaces (ifTable + ifXTable)
    try {
      const [ifRows, ifxRows] = await Promise.all([
        snmpWalkParsed(host, OIDS.interfaces.ifTable, walkOpts),
        snmpWalkParsed(host, OIDS.ifXTable.ifName, walkOpts),
      ]);
      result.interfaces = buildInterfaceTable(ifRows, ifxRows);
      result.interface_count = result.interfaces.length;
    } catch (e) {
      result.errors.push(`interfaces:${e.message}`);
    }

    // 3. VLANs
    try {
      const vlanRows = await snmpWalkParsed(host, OIDS.vlan.dot1qVlanStaticName, walkOpts);
      result.vlans = parseVlans(vlanRows);
    } catch (e) {
      result.errors.push(`vlans:${e.message}`);
    }

    // 4. Entity-MIB
    try {
      const entRows = await snmpWalkParsed(host, OIDS.entity.entPhysicalDescr, walkOpts);
      result.entity = parseEntityTable(entRows);
      result.serial = result.entity.chassis_serial;
      result.model = result.entity.chassis_model;
    } catch (e) {
      result.errors.push(`entity:${e.message}`);
    }

    // 5. ARP Table
    try {
      const arpRows = await snmpWalkParsed(host, OIDS.ip.ipNetToMediaPhysAddress, walkOpts);
      result.arp_table = parseArpTable(arpRows);
    } catch (e) {
      result.errors.push(`arp:${e.message}`);
    }

    // 6. CPU
    try {
      const cpuRows = await snmpWalkParsed(host, OIDS.ucd.ssCpuSystem, walkOpts);
      result.cpu = parseCpu(cpuRows);

      // hrProcessorLoad para contar cores
      const procRows = await snmpWalkParsed(host, OIDS.host.hrProcessorLoad, walkOpts);
      result.cpu.cores = procRows.length || 1;
    } catch (e) {
      result.errors.push(`cpu:${e.message}`);
    }

    // 7. Memória
    try {
      const memRows = await snmpWalkParsed(host, OIDS.ucd.memTotalReal, walkOpts);
      result.memory = parseMemory(memRows);
    } catch (e) {
      result.errors.push(`memory:${e.message}`);
    }

    // 8. Storage
    try {
      const storRows = await snmpWalkParsed(host, OIDS.host.hrStorageDescr, walkOpts);
      result.storage = parseStorage(storRows);
    } catch (e) {
      result.errors.push(`storage:${e.message}`);
    }

    // 9. Wireless
    try {
      const wlanRows = await snmpWalkParsed(host, OIDS.wireless.dot11DesiredSSID, walkOpts);
      result.wireless = parseWireless(wlanRows);
    } catch (e) {
      // Wireless não é crítico, ignora silenciosamente
    }

  } catch (e) {
    result.errors.push(`fatal:${e.message}`);
    log('error', `SNMP deep discovery fatal error for ${host}`, { err: e.message });
  }

  return result;
}

module.exports = { snmpDeepDiscover, probeSnmp, buildInterfaceTable, parseStorage, parseArpTable, parseWireless, parseVlans, parseEntityTable };
