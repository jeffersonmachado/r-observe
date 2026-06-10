'use strict';

// Bluetooth / BLE Scanner para R-Observe Discovery (Enterprise).
// Descobre dispositivos Bluetooth Classic e BLE (Bluetooth Low Energy)
// via hcitool, bluetoothctl e ferramentas do sistema.
//
// Requer: bluez, bluetoothctl, hcitool no host ou container com --privileged.
// Alcance: limitado ao raio fisico do adaptador BT do host (~10-100m).

const { exec } = require('child_process');
const { promisify } = require('util');
const { log } = require('../utils/logger');

const execAsync = promisify(exec);

const SCAN_TIMEOUT_SEC = parseInt(process.env.DISCOVERY_BT_SCAN_TIMEOUT || '10', 10);
const BLE_SCAN_DURATION = parseInt(process.env.DISCOVERY_BLE_SCAN_DURATION || '15', 10);

// ── Bluetooth Classic (hcitool scan) ─────────────────────────────────────

async function scanBluetoothClassic() {
  const devices = [];
  try {
    // hcitool scan: descobre dispositivos BT Classic visiveis
    const { stdout } = await execAsync(
      `timeout ${SCAN_TIMEOUT_SEC} hcitool scan 2>/dev/null`,
      { timeout: (SCAN_TIMEOUT_SEC + 5) * 1000 }
    );

    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*([0-9A-Fa-f:]{17})\s+(.+)$/);
      if (!m) continue;
      const mac = m[1].toLowerCase();
      const name = m[2].trim();

      // OUI vendor lookup
      const vendor = lookupBtVendor(mac);

      devices.push({
        mac,
        name: name !== 'n/a' ? name : null,
        vendor,
        type: 'bluetooth-classic',
        rssi: null,
      });
    }
  } catch (e) {
    log('warn', 'Bluetooth classic scan failed', { err: e.message });
  }

  // Enriquecer com info adicional (classe de dispositivo)
  for (const dev of devices) {
    try {
      const { stdout } = await execAsync(
        `hcitool info ${dev.mac} 2>/dev/null`,
        { timeout: 5000 }
      );
      const nameMatch = stdout.match(/Device Name:\s*(.+)/);
      const classMatch = stdout.match(/Device Class:\s*(.+)/);
      if (nameMatch && !dev.name) dev.name = nameMatch[1].trim();
      if (classMatch) dev.device_class = classMatch[1].trim();
    } catch (_) {}
  }

  return devices;
}

// ── BLE (hcitool lescan) ────────────────────────────────────────────────

async function scanBle() {
  const devices = [];
  let buffer = '';

  try {
    // hcitool lescan --duplicates para BLE (precisa de root/privileged)
    const proc = exec(`timeout ${BLE_SCAN_DURATION} hcitool lescan --duplicates 2>/dev/null`, {
      timeout: (BLE_SCAN_DURATION + 5) * 1000,
    });

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
    });

    await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.on('exit', resolve);
    });

    // Parse output: "LE Scan ..."
    for (const line of buffer.split('\n')) {
      // Formato: "AA:BB:CC:DD:EE:FF (name)" ou so "AA:BB:CC:DD:EE:FF"
      const m = line.match(/([0-9A-Fa-f:]{17})\s*(?:\((.+)\))?/);
      if (!m) continue;
      const mac = m[1].toLowerCase();
      const name = m[2]?.trim() || null;
      const vendor = lookupBtVendor(mac);

      // Dedup por MAC
      if (!devices.find(d => d.mac === mac)) {
        devices.push({
          mac,
          name,
          vendor,
          type: 'ble',
          rssi: null,
        });
      }
    }
  } catch (e) {
    log('warn', 'BLE scan failed', { err: e.message });
  }

  return devices;
}

// ── bluetoothctl (modo interativo programatico) ─────────────────────────

async function scanWithBluetoothctl() {
  const devices = [];

  try {
    // bluetoothctl: mais informativo, mostra RSSI
    const script = [
      'power on',
      'agent on',
      'scan on',
      `sleep ${BLE_SCAN_DURATION}`,
      'scan off',
      'devices',
      'exit',
    ].join('\n');

    const { stdout } = await execAsync(
      `echo "${script}" | bluetoothctl 2>/dev/null`,
      { timeout: (BLE_SCAN_DURATION + 10) * 1000 }
    );

    for (const line of stdout.split('\n')) {
      // "Device AA:BB:CC:DD:EE:FF Device Name"
      const m = line.match(/Device\s+([0-9A-Fa-f:]{17})\s+(.+)/);
      if (!m) continue;
      const mac = m[1].toLowerCase();
      const name = m[2].trim();
      const vendor = lookupBtVendor(mac);

      if (!devices.find(d => d.mac === mac)) {
        devices.push({
          mac,
          name: name !== '(null)' ? name : null,
          vendor,
          type: 'bluetooth',
          rssi: null,
        });
      }
    }

    // Info detalhada de cada device
    for (const dev of devices) {
      try {
        const { stdout: info } = await execAsync(
          `bluetoothctl info ${dev.mac} 2>/dev/null`,
          { timeout: 5000 }
        );
        const rssiMatch = info.match(/RSSI:\s*(-?\d+)/);
        const classMatch = info.match(/Class:\s*(0x[0-9a-fA-F]+)/);
        const pairedMatch = info.match(/Paired:\s*(yes|no)/);
        const trustedMatch = info.match(/Trusted:\s*(yes|no)/);

        if (rssiMatch) dev.rssi = parseInt(rssiMatch[1], 10);
        if (classMatch) dev.device_class = classMatch[1];
        if (pairedMatch) dev.paired = pairedMatch[1] === 'yes';
        if (trustedMatch) dev.trusted = trustedMatch[1] === 'yes';
      } catch (_) {}
    }

  } catch (e) {
    log('warn', 'bluetoothctl scan failed', { err: e.message });
  }

  return devices;
}

// ── OUI Vendor Lookup ────────────────────────────────────────────────────

const BT_OUI = {
  '00:1B:DC': 'Apple',
  '00:1E:C2': 'Apple',
  '00:1F:F3': 'Apple',
  '04:F1:3E': 'Apple',
  '0C:3E:9F': 'Apple',
  '10:40:F3': 'Apple',
  '14:BD:61': 'Apple',
  '20:AB:37': 'Apple',
  '24:A0:74': 'Apple',
  '28:37:37': 'Apple',
  '2C:BE:08': 'Apple',
  '30:10:E4': 'Apple',
  '34:51:C9': 'Apple',
  '38:CA:DA': 'Apple',
  '40:30:04': 'Apple',
  '44:4C:A8': 'Apple',
  '4C:32:75': 'Apple',
  '54:AE:27': 'Apple',
  '60:FE:C5': 'Apple',
  '64:A5:C3': 'Apple',
  '68:D9:3C': 'Apple',
  '6C:8D:C1': 'Apple',
  '70:3E:97': 'Apple',
  '78:FD:94': 'Apple',
  '7C:04:D0': 'Apple',
  '88:CB:A5': 'Samsung',
  '8C:F5:A3': 'Samsung',
  '90:B9:31': 'Samsung',
  '18:4F:32': 'Samsung',
  '04:8D:DB': 'Samsung',
  '00:23:D4': 'Samsung',
  '00:1A:89': 'Samsung',
  'CC:05:77': 'Samsung',
  '18:89:5B': 'Google',
  '00:1A:11': 'Google',
  '54:60:09': 'Google',
  '38:8B:59': 'Google',
  'AC:5F:3E': 'Xiaomi',
  'C4:0B:31': 'Xiaomi',
  '7C:1D:D9': 'Xiaomi',
  '00:1D:FE': 'Sony',
  '04:5D:4B': 'Sony',
  '30:F7:72': 'Sony',
  'AC:9B:0A': 'Sony',
  '00:26:BB': 'LG',
  '00:23:76': 'LG',
  '04:4E:AF': 'LG',
  'F8:1E:DF': 'LG',
  '00:0D:44': 'Garmin',
  '00:1C:DF': 'Fitbit',
  '00:1E:4C': 'Roku',
  '00:0D:4B': 'Bose',
  '00:1C:AB': 'Bose',
  '08:DF:1F': 'Bose',
  '00:02:5B': 'Ericsson',
  'DC:0D:30': 'Nokia',
  '00:19:C1': 'Jabra',
  '00:13:17': 'Plantronics',
  '00:0E:6D': 'Logitech',
  '00:07:61': 'Logitech',
  '00:18:6E': 'Motorola',
  '00:17:B5': 'Dell',
  '00:1E:4F': 'Dell',
  '00:14:A4': 'HP',
  '00:23:7E': 'HP',
  '00:60:57': 'Intel',
  '00:19:D2': 'Intel',
  'AC:37:43': 'Dell',
  '88:C9:D0': 'LG',
  '90:E1:7B': 'Xiaomi',
  'C8:3A:6B': 'Xiaomi',
  'F0:64:91': 'Xiaomi',
  '98:52:3D': 'Xiaomi',
  '00:18:31': 'Nintendo',
  '00:22:D7': 'Nintendo',
  '00:24:F3': 'Nintendo',
  'B8:F6:B1': 'Nintendo',
  '00:1E:AB': 'Nintendo',
  '00:04:4B': 'Nokia',
  '00:16:DC': 'Nokia',
  '00:18:C6': 'Amazon',
  '00:1C:B3': 'Amazon',
  '00:21:27': 'Amazon',
  '50:F5:DA': 'Amazon',
  'FC:65:DE': 'Amazon',
  '00:12:1A': 'Philips',
  '00:1E:2A': 'Philips',
  '74:A5:28': 'Huawei',
  '80:B6:86': 'Huawei',
  '9C:A9:E4': 'Huawei',
};

function lookupBtVendor(mac) {
  if (!mac) return null;
  const prefix = mac.slice(0, 8).toUpperCase();
  return BT_OUI[prefix] || null;
}

// Classifica tipo de dispositivo baseado no nome e vendor.
function classifyBtDevice(name, vendor) {
  const n = (name || '').toLowerCase();
  const v = (vendor || '').toLowerCase();

  if (n.includes('watch') || n.includes('band') || n.includes('fitbit') || n.includes('garmin')) return 'wearable';
  if (n.includes('buds') || n.includes('headphone') || n.includes('earphone') || n.includes('airpods') || n.includes('galaxy buds')) return 'audio';
  if (n.includes('speaker') || n.includes('sound') || v.includes('bose') || v.includes('jbl')) return 'audio';
  if (n.includes('phone') || n.includes('iphone') || n.includes('galaxy') || n.includes('pixel') || n.includes('motorola')) return 'mobile';
  if (n.includes('tv') || n.includes('remote') || n.includes('roku') || n.includes('fire tv')) return 'media_device';
  if (n.includes('keyboard') || n.includes('mouse') || n.includes('trackpad') || v.includes('logitech')) return 'peripheral';
  if (n.includes('switch') || n.includes('controller') || v.includes('nintendo') || v.includes('sony')) return 'gaming';
  if (n.includes('tracker') || n.includes('tag') || n.includes('tile') || n.includes('airtag')) return 'tracker';
  if (n.includes('sensor') || n.includes('thermo') || n.includes('scale') || n.includes('toothbrush')) return 'iot';
  if (n.includes('car') || n.includes('vehicle') || n.includes('auto')) return 'vehicle';
  if (v.includes('apple') && !n.includes('phone')) return 'mobile';

  return 'bluetooth-device';
}

// Orquestrador.
async function discoverBluetooth() {
  const allDevices = [];
  const seenMacs = new Set();

  const addDevices = (devices, source) => {
    for (const d of devices) {
      if (seenMacs.has(d.mac)) continue;
      seenMacs.add(d.mac);
      d.source = source;
      d.device_type = classifyBtDevice(d.name, d.vendor);
      allDevices.push(d);
    }
  };

  // Tenta multiplos metodos, fallback progressivo
  try {
    const btctl = await scanWithBluetoothctl();
    addDevices(btctl, 'bluetoothctl');
  } catch (_) {}

  try {
    const classic = await scanBluetoothClassic();
    addDevices(classic, 'hcitool-classic');
  } catch (_) {}

  try {
    const ble = await scanBle();
    addDevices(ble, 'hcitool-ble');
  } catch (_) {}

  log('info', 'Bluetooth/BLE discovery completed', {
    total: allDevices.length,
    classic: allDevices.filter(d => d.type === 'bluetooth-classic').length,
    ble: allDevices.filter(d => d.type === 'ble').length,
    btctl: allDevices.filter(d => d.type === 'bluetooth').length,
  });

  return allDevices;
}

module.exports = { discoverBluetooth, scanBluetoothClassic, scanBle, scanWithBluetoothctl, classifyBtDevice };
