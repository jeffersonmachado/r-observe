'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const { log } = require('../utils/logger');
const { isValidIPv4 } = require('./target-expansion');
const { normalizeMac, analyzeMacType, vendorReliability } = require('../utils/mac-utils');
const { lookupMacVendor } = require('../fingerprint/oui');
const { debug, debugTable, isDebug } = require('../utils/logger');

const execAsync = promisify(exec);

// Vendor OUI (Organizationally Unique Identifier) database
// First 3 octets of MAC address → Vendor name
const OUI_VENDORS = {
  '00:1A:8A': 'Cisco',
  '00:1B:44': 'MikroTik',
  '00:25:86': 'Cisco',
  '00:48:54': 'Cisco',
  '24:A4:3C': 'Intelbras',
  '3C:5A:B4': 'Hikvision',
  'F0:AD:4E': 'Grandstream',
  'AC:DE:48': 'ControlID',
  '08:00:27': 'PCS Systemtechnik',
  'AA:00:04': 'Unisys',
  '08:60:6E': 'Arista',
  '14:CC:20': 'Cisco',
  '00:C0:CA': 'Cisco',
  '00:0E:C6': 'Cisco',
  '00:10:A6': 'Cisco',
  '00:1E:F6': 'Cisco',
  '00:21:A0': 'Cisco',
  '00:23:04': 'Cisco',
  '00:24:C3': 'Cisco',
  '00:26:CA': 'Cisco',
  '00:2A:6A': 'Cisco',
  '00:2D:E3': 'Cisco',
  '00:30:7B': 'Cisco',
  '00:35:1C': 'Cisco',
  '00:3A:98': 'Cisco',
  '00:40:96': 'Cisco',
  '00:41:D2': 'Cisco',
  '00:4C:AF': 'Cisco',
  '00:4E:54': 'Cisco',
  '00:55:DA': 'Cisco',
  '00:5E:4F': 'Cisco',
  '00:62:EC': 'Cisco',
  '00:64:40': 'Cisco',
  '00:90:86': 'Cisco',
  '00:A0:C9': 'Cisco',
  '00:AA:00': 'Intel',
  '00:D0:58': 'Xerox',
  '00:E0:18': 'Cisco',
  '00:E0:B6': 'Cisco',
  '08:BB:CA': 'Meraki',
  '54:EE:75': 'Ubiquiti',
  '6C:70:9F': 'Ubiquiti',
  'C0:25:06': 'D-Link',
  'D4:6E:0E': 'TP-Link',
  '48:A8:E0': 'Apple',
  '6C:AD:F8': 'Apple',
  '00:1D:43': 'NETGEAR',
  '00:22:6B': 'Lexmark',
  '00:0C:29': 'VMware',
  '08:00:27': 'VirtualBox',
};

/**
 * Parse ARP table output and extract MAC/IP mappings.
 * Format (Linux/Unix arp command):
 * IP Address              HW type     Flags       HW address            Mask     Device
 * 10.10.2.1              ether      --c-        a4:5e:60:e2:24:0a     *        eth0
 */
function parseArpTable(output) {
  const entries = [];
  const lines = String(output || '').split(/\n|\\n/).filter(l => l.trim());

  for (const line of lines) {
    // Skip headers and invalid lines
    if (line.includes('Address') || line.startsWith('IP address') || !line.trim()) continue;

    // ip neigh style: "10.10.2.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
    const neighMatch = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f:-]{17})\s*/i);
    if (neighMatch) {
      const ip = neighMatch[1];
      const device = neighMatch[2];
      const mac = normalizeMac(neighMatch[3]);
      if (isValidIPv4(ip) && mac) entries.push({ ip, mac, device });
      continue;
    }

    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) continue;

    // Linux arp style: "10.10.2.1 ether aa:bb:... C eth0"
    const ip = parts[0].replace(/[()]/g, '');
    const macField = parts.find((p) => normalizeMac(p));
    const mac = normalizeMac(macField);
    if (!mac) continue;
    const ifacePattern = /^(?:eth\d*|enp\w+|ens\w+|eno\w+|wlan\d*|wl\w*|br\w*|bond\d*|vlan\d+|tun\d*|tap\d*|docker\d*)$/i;
    const device = parts.find((p) => ifacePattern.test(p)) || parts[parts.length - 1] || 'unknown';

    // Validate IP and MAC format
    if (!isValidIPv4(ip)) continue;

    entries.push({ ip, mac, device });
  }

  return entries;
}

function parseProcNetArp(output) {
  const lines = String(output || '').split(/\n|\\n/).map((l) => l.trim()).filter(Boolean);
  const entries = [];

  for (const line of lines) {
    if (line.startsWith('IP address')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const ip = parts[0];
    const mac = normalizeMac(parts[3]);
    const device = parts[5];
    if (!isValidIPv4(ip) || !mac || mac === '00:00:00:00:00:00') continue;
    entries.push({ ip, mac, device });
  }
  return entries;
}

async function hasCommand(cmd, execFn = execAsync) {
  try {
    await execFn(`command -v ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

async function safeExec(command, execFn = execAsync) {
  try {
    const { stdout } = await execFn(command);
    return { ok: true, stdout: stdout || '' };
  } catch (e) {
    return { ok: false, stdout: e?.stdout || '', stderr: e?.stderr || e?.message || '' };
  }
}

/**
 * Lookup vendor name from MAC address OUI.
 * Uses both local OUI_VENDORS and IEEE OUI database.
 * Returns null if vendor is unknown.
 */
function vendorFromMac(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  // Primeiro consulta o IEEE OUI database (mais completo)
  const ieeeVendor = lookupMacVendor(normalized);
  if (ieeeVendor) return ieeeVendor;
  // Fallback para OUI_VENDORS local
  const oui = normalized.slice(0, 8).toUpperCase();
  return OUI_VENDORS[oui] || null;
}

/**
 * Constroi metadados de MAC para um asset: mac_type, vendor_reliable, etc.
 */
function buildMacMetadata(mac, vendor) {
  const analysis = analyzeMacType(mac);
  const reliability = vendorReliability(mac, vendor);

  const meta = {
    mac_address: mac,
    mac_type: reliability.mac_type,
    is_locally_administered: analysis ? analysis.is_locally_administered : false,
    is_multicast: analysis ? analysis.is_multicast : false,
    vendor,
    vendor_reliable: reliability.vendor_reliable,
    vendor_reliability_reason: reliability.reason,
  };

  if (isDebug()) {
    debug(`arp:mac-metadata mac=${mac}`, meta);
  }

  return meta;
}

/**
 * Discover local ARP table and identify devices on the network.
 * Requires:
 * - arp-scan utility (or parse system arp table)
 * - root/sudo privileges on some systems
 */
async function discoverArpTable(options = {}) {
  const execFn = options.execFn || execAsync;
  const assets = [];

  try {
    // Try to use arp-scan if available
    if (!options.disableArpScan) {
      const arpScanAvailable = await hasCommand('arp-scan', execFn);
      if (arpScanAvailable) {
        const scanned = await discoverArpScan(null, { execFn });
        if (scanned.length) return scanned;
      }
    }

    // Deterministic fallback chain
    const fallbackCommands = [
      { cmd: 'ip neigh show', parser: parseArpTable, source: 'ip_neigh' },
      { cmd: 'arp -an', parser: parseArpTable, source: 'arp_an' },
      { cmd: 'arp -a', parser: parseArpTable, source: 'arp_a' },
      { cmd: 'cat /proc/net/arp', parser: parseProcNetArp, source: 'proc_net_arp' },
      // Host ARP table (montado via volume: /proc/net/arp:/host-arp:ro)
      { cmd: 'cat /host-arp 2>/dev/null', parser: parseProcNetArp, source: 'host_proc_net_arp' },
    ];

    let entries = [];
    let source = 'none';
    let permissionRestricted = false;
    for (const item of fallbackCommands) {
      const out = await safeExec(item.cmd, execFn);
      if (!out.ok) {
        if (/permission denied|operation not permitted/i.test(out.stderr || '')) {
          permissionRestricted = true;
          log('warn', 'ARP command permission denied', { command: item.cmd, error: out.stderr });
        }
        continue;
      }
      entries = item.parser(out.stdout);
      if (entries.length) {
        source = item.source;
        break;
      }
    }
    
    for (const entry of entries) {
      const vendor = vendorFromMac(entry.mac);
      const macMeta = buildMacMetadata(entry.mac, vendor);
      
      assets.push({
        asset_type: 'network_device',
        primary_ip: entry.ip,
        mac_address: entry.mac,
        vendor: vendor,
        mac_type: macMeta.mac_type,
        is_locally_administered: macMeta.is_locally_administered,
        vendor_reliable: macMeta.vendor_reliable,
        discovery_method: 'arp',
        last_seen_on_device: entry.device,
        confidence: 0.9,
        metadata: {
          arp_entry: entry,
          discovery_source: source,
          permission_restricted: permissionRestricted,
          mac_metadata: macMeta,
        },
      });
    }

    log('info', 'ARP discovery complete', { discovered: assets.length });

    if (isDebug() && assets.length > 0) {
      debugTable('arp:discovered-assets', assets.map(a => ({
        ip: a.primary_ip,
        mac: a.mac_address,
        vendor: a.vendor,
        mac_type: a.mac_type,
        vendor_reliable: a.vendor_reliable,
        is_laa: a.is_locally_administered,
      })));
    }
  } catch (e) {
    log('error', 'ARP discovery failed', { error: e.message });
  }

  return assets;
}

/**
 * Advanced arp-scan discovery (if available).
 * Scans a subnet and identifies active devices.
 */
async function discoverArpScan(subnet = null, options = {}) {
  const execFn = options.execFn || execAsync;
  const assets = [];

  try {
    const cmd = subnet ? `arp-scan ${subnet}` : 'arp-scan -l';
    const { stdout } = await execFn(cmd);

    const lines = stdout.split('\n');
    
    for (const line of lines) {
      // Skip headers and summary lines
      if (line.includes('Interface') || line.includes('packets') || !line.trim()) continue;

      const parts = line.trim().split(/\t+/);
      if (parts.length < 3) continue;

      const ip = parts[0];
      const mac = normalizeMac(parts[1]);
      const device = parts[2];

      // Validate format
      if (!isValidIPv4(ip)) continue;
      if (!mac) continue;

      const vendor = vendorFromMac(mac);
      const macMeta = buildMacMetadata(mac, vendor);

      assets.push({
        asset_type: 'network_device',
        primary_ip: ip,
        mac_address: mac,
        vendor: vendor,
        mac_type: macMeta.mac_type,
        is_locally_administered: macMeta.is_locally_administered,
        vendor_reliable: macMeta.vendor_reliable,
        device_name: device,
        discovery_method: 'arp_scan',
        confidence: 0.95,
        metadata: {
          mac_vendor: vendor,
          discovered_via_arp_scan: true,
          mac_metadata: macMeta,
        },
      });
    }

    log('info', 'ARP scan discovery complete', { discovered: assets.length });
  } catch (e) {
    const msg = String(e?.stderr || e?.message || 'arp-scan failed');
    const permissionDenied = /permission denied|operation not permitted/i.test(msg);
    log('warn', 'ARP scan not available or failed', { error: msg, permissionDenied });
  }

  return assets;
}

/**
 * Classify device type based on MAC vendor and naming patterns.
 * ATENÇÃO: Esta classificação é apenas um hint inicial.
 * A classificação final é feita pelo inference engine com múltiplas evidências.
 */
function classifyArpDevice(asset) {
  const vendor = asset.vendor || '';
  const ip = asset.primary_ip || '';
  const deviceName = asset.device_name || '';

  // Se o MAC é localmente administrado, não classificar por vendor
  if (asset.is_locally_administered) {
    return 'host';
  }

  // Rule-based classification
  if (vendor.toLowerCase().includes('cisco') || vendor.toLowerCase().includes('arista')) {
    return 'network_switch';
  }
  if (vendor.toLowerCase().includes('mikrotik')) {
    return 'router';
  }
  if (vendor.toLowerCase().includes('ubiquiti')) {
    return 'wireless_ap';
  }
  if (vendor.toLowerCase().includes('hikvision') || vendor.toLowerCase().includes('dahua')) {
    return 'ip_camera';
  }
  if (vendor.toLowerCase().includes('grandstream') || vendor.toLowerCase().includes('yealink')) {
    return 'voip_phone';
  }
  if (vendor.toLowerCase().includes('intelbras') || vendor.toLowerCase().includes('controlid')) {
    return 'access_control';
  }

  return 'unknown_network_device';
}

/**
 * Enrich ARP discovery with device classification and additional metadata.
 */
function enrichArpAssets(assets) {
  return assets.map((asset) => ({
    ...asset,
    device_type: classifyArpDevice(asset),
    discovered_at: new Date().toISOString(),
  }));
}

module.exports = {
  discoverArpTable,
  discoverArpScan,
  parseArpTable,
  parseProcNetArp,
  normalizeMac,
  vendorFromMac,
  buildMacMetadata,
  classifyArpDevice,
  enrichArpAssets,
  hasCommand,
  OUI_VENDORS,
};
