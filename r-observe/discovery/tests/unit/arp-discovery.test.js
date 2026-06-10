'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseArpTable,
  parseProcNetArp,
  normalizeMac,
  vendorFromMac,
  enrichArpAssets,
  OUI_VENDORS,
} = require('../../src/scanners/arp-discovery');

test('parseArpTable: parses valid ARP output', () => {
  const output = `Address                  HWtype  HWaddress           Flags Mask            Iface
10.10.2.1                ether   a4:5e:60:e2:24:0a   C                     eth0
10.10.2.99               ether   08:00:27:1e:2d:d0   C                     eth0
10.10.2.254              ether   3c:5a:b4:1a:2b:3c   C                     eth0`;

  const entries = parseArpTable(output);
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].ip, '10.10.2.1');
  assert.strictEqual(entries[0].mac, 'a4:5e:60:e2:24:0a');
  assert.strictEqual(entries[0].device, 'eth0');
});

test('parseArpTable: skips invalid entries', () => {
  const output = `Address                  HWtype  HWaddress           Flags Mask            Iface
10.10.2.1                ether   a4:5e:60:e2:24:0a   C                     eth0
invalid-line
10.10.2.99`;

  const entries = parseArpTable(output);
  assert.strictEqual(entries.length, 1);
});

test('parseArpTable: rejeita IPv4 inválido', () => {
  const output = `Address HWtype HWaddress Flags Mask Iface
10.10.2.999 ether a4:5e:60:e2:24:0a C * eth0`;
  const entries = parseArpTable(output);
  assert.strictEqual(entries.length, 0);
});

test('parseArpTable: parses ip neigh output', () => {
  const output = `10.10.2.1 dev eth0 lladdr a4:5e:60:e2:24:0a REACHABLE
10.10.2.99 dev eth0 lladdr 08:00:27:1e:2d:d0 STALE`;

  const entries = parseArpTable(output);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].device, 'eth0');
  assert.strictEqual(entries[1].mac, '08:00:27:1e:2d:d0');
});

test('parseProcNetArp: parses linux proc table', () => {
  const output = `IP address       HW type     Flags       HW address            Mask     Device
10.10.2.1        0x1         0x2         a4:5e:60:e2:24:0a     *        eth0
10.10.2.99       0x1         0x2         08:00:27:1e:2d:d0     *        eth0`;

  const entries = parseProcNetArp(output);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].ip, '10.10.2.1');
  assert.strictEqual(entries[1].mac, '08:00:27:1e:2d:d0');
});

test('vendorFromMac: resolves MikroTik', () => {
  const vendor = vendorFromMac('00:1B:44:aa:bb:cc');
  assert.strictEqual(vendor, 'MikroTik');
});

test('vendorFromMac: resolves Hikvision', () => {
  const vendor = vendorFromMac('3C:5A:B4:11:22:33');
  assert.strictEqual(vendor, 'Hikvision');
});

test('vendorFromMac: returns null for unknown vendor', () => {
  const vendor = vendorFromMac('FF:FF:FF:aa:bb:cc');
  assert.strictEqual(vendor, null);
});

test('vendorFromMac: case insensitive', () => {
  const vendor1 = vendorFromMac('00:1b:44:aa:bb:cc');
  const vendor2 = vendorFromMac('00:1B:44:AA:BB:CC');
  assert.strictEqual(vendor1, vendor2);
});

test('normalizeMac: converte hífen para dois-pontos', () => {
  assert.strictEqual(normalizeMac('00-1B-44-AA-BB-CC'), '00:1b:44:aa:bb:cc');
});

test('OUI_VENDORS: contains common vendors', () => {
  assert.ok(OUI_VENDORS['00:1B:44']); // MikroTik
  assert.ok(OUI_VENDORS['3C:5A:B4']); // Hikvision
  assert.ok(OUI_VENDORS['F0:AD:4E']); // Grandstream
  assert.ok(OUI_VENDORS['24:A4:3C']); // Intelbras
});

test('enrichArpAssets: adds device_type and timestamp', () => {
  const assets = [
    {
      asset_type: 'network_device',
      primary_ip: '10.10.2.1',
      mac_address: '00:1B:44:aa:bb:cc',
      vendor: 'MikroTik',
    },
  ];

  const enriched = enrichArpAssets(assets);
  assert.strictEqual(enriched.length, 1);
  assert.ok(enriched[0].device_type);
  assert.ok(enriched[0].discovered_at);
});

test('enrichArpAssets: classifies MikroTik as router', () => {
  const assets = [
    {
      asset_type: 'network_device',
      primary_ip: '10.10.2.1',
      mac_address: '00:1B:44:aa:bb:cc',
      vendor: 'MikroTik',
    },
  ];

  const enriched = enrichArpAssets(assets);
  assert.strictEqual(enriched[0].device_type, 'router');
});

test('enrichArpAssets: classifies Cisco as network_switch', () => {
  const assets = [
    {
      asset_type: 'network_device',
      primary_ip: '10.10.2.50',
      mac_address: '00:1A:8A:aa:bb:cc',
      vendor: 'Cisco',
    },
  ];

  const enriched = enrichArpAssets(assets);
  assert.strictEqual(enriched[0].device_type, 'network_switch');
});

test('enrichArpAssets: classifies Hikvision as ip_camera', () => {
  const assets = [
    {
      asset_type: 'network_device',
      primary_ip: '10.10.2.100',
      mac_address: '3C:5A:B4:aa:bb:cc',
      vendor: 'Hikvision',
    },
  ];

  const enriched = enrichArpAssets(assets);
  assert.strictEqual(enriched[0].device_type, 'ip_camera');
});

test('enrichArpAssets: classifies Ubiquiti as wireless_ap', () => {
  const assets = [
    {
      asset_type: 'network_device',
      primary_ip: '10.10.2.75',
      mac_address: '54:EE:75:aa:bb:cc',
      vendor: 'Ubiquiti',
    },
  ];

  const enriched = enrichArpAssets(assets);
  assert.strictEqual(enriched[0].device_type, 'wireless_ap');
});

test('enrichArpAssets: classifies Grandstream as voip_phone', () => {
  const assets = [
    {
      asset_type: 'network_device',
      primary_ip: '10.10.2.80',
      mac_address: 'F0:AD:4E:aa:bb:cc',
      vendor: 'Grandstream',
    },
  ];

  const enriched = enrichArpAssets(assets);
  assert.strictEqual(enriched[0].device_type, 'voip_phone');
});

test('enrichArpAssets: classifies ControlID as access_control', () => {
  const assets = [
    {
      asset_type: 'network_device',
      primary_ip: '10.10.2.90',
      mac_address: 'AC:DE:48:aa:bb:cc',
      vendor: 'ControlID',
    },
  ];

  const enriched = enrichArpAssets(assets);
  assert.strictEqual(enriched[0].device_type, 'access_control');
});
