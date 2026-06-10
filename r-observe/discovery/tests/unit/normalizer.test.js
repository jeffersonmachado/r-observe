'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeArpAsset,
  normalizeNmapScan,
  normalizeAsset,
} = require('../../src/normalizers/asset-normalizer');

const fixtures = require('../fixtures/real-network-data');

test('normalizeArpAsset: gateway com MAC LAA', () => {
  const result = normalizeArpAsset(fixtures.gatewayArpRaw, {
    isGateway: true,
    isLocalhost: false,
  });

  assert.equal(result.ip, '192.168.0.1');
  assert.equal(result.mac, '02:10:18:5c:5e:4b');
  assert.equal(result.vendor_reliable, false);
  assert.equal(result.mac_type, 'locally_administered');
  assert.equal(result.is_gateway, true);
  assert.equal(result.is_localhost, false);
  // Deve ter evidência de gateway
  const gwEvidence = result.evidence.find(e =>
    e.normalized_data?.topology_flags?.includes('gateway')
  );
  assert.ok(gwEvidence);
  // Deve ter evidência de MAC structure
  const macEvidence = result.evidence.find(e => e.evidence_type === 'mac_structure');
  assert.ok(macEvidence);
  assert.equal(macEvidence.normalized_data.mac_type, 'locally_administered');
});

test('normalizeArpAsset: host com MAC conhecido (50:BA:02 = Motorola/Hisense)', () => {
  const result = normalizeArpAsset(fixtures.appServerArpRaw, {
    isGateway: false,
    isLocalhost: false,
  });

  assert.equal(result.ip, '192.168.0.43');
  assert.equal(result.mac, '50:ba:02:b0:9c:4a');
  assert.equal(result.vendor, 'Motorola/Hisense');
  assert.equal(result.vendor_reliable, true);
  assert.equal(result.mac_type, 'global_unicast');
  assert.equal(result.is_gateway, false);
  assert.equal(result.is_localhost, false);
  // Vendor conhecido → confiança alta
  const vendorEvidence = result.evidence.find(e => e.evidence_type === 'vendor_identity');
  assert.ok(vendorEvidence);
  assert.ok(vendorEvidence.confidence >= 0.5, 'Vendor conhecido deve ter confiança razoável');
});

test('normalizeArpAsset: host com MAC verdadeiramente desconhecido (DE:AD:BE:EF)', () => {
  const result = normalizeArpAsset(fixtures.unknownMacHost, {
    isGateway: false,
    isLocalhost: false,
  });

  assert.equal(result.ip, '192.168.0.99');
  assert.equal(result.mac, 'de:ad:be:ef:00:01');
  assert.equal(result.vendor, 'Unknown');
  assert.equal(result.vendor_reliable, false);
  // Vendor unknown → confiança baixa
  const vendorEvidence = result.evidence.find(e => e.evidence_type === 'vendor_identity');
  assert.ok(vendorEvidence);
  assert.ok(vendorEvidence.confidence < 0.3, 'Vendor unknown deve ter confiança baixa');
});

test('normalizeArpAsset: host local com MAC LAA', () => {
  const result = normalizeArpAsset(fixtures.localHostArpRaw, {
    isGateway: false,
    isLocalhost: true,
  });

  assert.equal(result.is_localhost, true);
  assert.equal(result.mac_type, 'locally_administered');
  const localEvidence = result.evidence.find(e =>
    e.normalized_data?.topology_flags?.includes('localhost')
  );
  assert.ok(localEvidence);
});

test('normalizeNmapScan: separa portas open e filtered', () => {
  const result = normalizeNmapScan(fixtures.appServerNmapScan, null);

  assert.equal(result.ip, '192.168.0.43');
  assert.equal(result.open_ports.length, 5);
  assert.equal(result.filtered_ports.length, 2);

  // Portas open
  const openPorts = result.open_ports.map(p => p.port);
  assert.ok(openPorts.includes(7000));
  assert.ok(openPorts.includes(8008));
  assert.ok(openPorts.includes(8009));
  assert.ok(openPorts.includes(8443));
  assert.ok(openPorts.includes(9000));

  // Portas filtered
  const filteredPorts = result.filtered_ports.map(p => p.port);
  assert.ok(filteredPorts.includes(8088));
  assert.ok(filteredPorts.includes(9001));

  // Evidência agregada de port scan (não individual)
  const scanEvidence = result.evidence.find(e => e.evidence_type === 'port_scan_completed');
  assert.ok(scanEvidence);
  assert.equal(scanEvidence.normalized_data.open_count, 5);
  assert.equal(scanEvidence.normalized_data.filtered_count, 2);

  // Network distance
  const distEvidence = result.evidence.find(e => e.evidence_type === 'network_distance');
  assert.ok(distEvidence);
  assert.equal(distEvidence.normalized_data.distance, 1);
  assert.equal(distEvidence.normalized_data.network_proximity, 'local');
});

test('normalizeAsset: combina ARP + Nmap com gateway', () => {
  const result = normalizeAsset(
    fixtures.gatewayArpRaw,
    fixtures.appServerNmapScan, // só para ter scan, não importa o IP
    { isGateway: true, isLocalhost: false }
  );

  assert.equal(result.is_gateway, true);
  assert.ok(result.evidence.length > 5, 'Deve ter múltiplas evidências');
});

test('normalizeAsset: funciona sem ARP (só Nmap)', () => {
  const result = normalizeAsset(null, fixtures.appServerNmapScan, {
    isGateway: false,
    isLocalhost: false,
  });

  assert.equal(result.ip, '192.168.0.43');
  assert.equal(result.open_ports.length, 5);
  assert.equal(result.filtered_ports.length, 2);
  // Deve ter evidência host_alive
  const aliveEvidence = result.evidence.find(e => e.evidence_type === 'host_alive');
  assert.ok(aliveEvidence);
});

test('normalizeAsset: app server completo (ARP + Nmap)', () => {
  const result = normalizeAsset(
    fixtures.appServerArpRaw,
    fixtures.appServerNmapScan,
    { isGateway: false, isLocalhost: false }
  );

  assert.equal(result.ip, '192.168.0.43');
  assert.equal(result.mac, '50:ba:02:b0:9c:4a');
  // 50:BA:02 está na OUI → vendor_reliable = true
  assert.equal(result.vendor_reliable, true);
  // Deve ter evidências de ARP, MAC, vendor, port scan agregado, network distance
  const evidenceTypes = result.evidence.map(e => e.evidence_type);
  assert.ok(evidenceTypes.includes('arp_discovery'));
  assert.ok(evidenceTypes.includes('mac_structure'));
  assert.ok(evidenceTypes.includes('vendor_identity'));
  assert.ok(evidenceTypes.includes('port_scan_completed'));
  assert.ok(evidenceTypes.includes('network_distance'));
  // Portas nos arrays
  assert.equal(result.open_ports.length, 5);
  assert.equal(result.filtered_ports.length, 2);
});
