'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTopologyEdges } = require('../../src/topology/engine');

test('gera arestas de dependencia a partir de services', () => {
  const edges = buildTopologyEdges('run-1', [{ id: 'a1', services: [{ dependency_target: '10.10.2.99:3306', protocol: 'tcp' }] }]);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].to_asset_ref, '10.10.2.99:3306');
});

test('topology: host -> service, service -> db/dns/exporter e container -> service', () => {
  const assets = [{
    id: 'asset-1',
    primary_ip: '10.0.0.1',
    services: [
      { port: 5432, protocol: 'tcp' },
      { port: 53,   protocol: 'udp' },
      { port: 9100, protocol: 'tcp' },
      { port: 80,   protocol: 'tcp', container_id: 'abc123' },
    ],
  }];
  const edges = buildTopologyEdges('run-x', assets);
  const types = edges.map(e => e.edge_type);
  assert.ok(types.includes('host_service'));
  assert.ok(types.includes('service_database'));
  assert.ok(types.includes('service_dns'));
  assert.ok(types.includes('service_exporter'));
  assert.ok(types.includes('container_service'));
});

test('topology: deduplicação de edges', () => {
  const assets = [{
    id: 'asset-dup',
    primary_ip: '10.0.0.2',
    services: [
      { port: 80, protocol: 'tcp' },
      { port: 80, protocol: 'tcp' },
    ],
  }];
  const edges = buildTopologyEdges('run-dup', assets);
  const hostEdges = edges.filter(e => e.edge_type === 'host_service' && e.to_asset_ref === '10.0.0.2:80');
  assert.equal(hostEdges.length, 1, 'edges duplicados devem ser deduplicados');
});

test('topology: edges contêm confidence e evidence reais', () => {
  const assets = [{
    id: 'asset-ev',
    primary_ip: '10.0.0.3',
    services: [{ port: 443, protocol: 'tcp' }],
  }];
  const edges = buildTopologyEdges('run-ev', assets);
  for (const e of edges) {
    assert.ok(typeof e.confidence === 'number', 'confidence deve ser número');
    assert.ok(e.confidence >= 0 && e.confidence <= 1, 'confidence entre 0 e 1');
    assert.ok(Array.isArray(e.evidence), 'evidence deve ser array');
    assert.ok(e.last_seen, 'last_seen deve estar presente');
  }
});

test('topology: LLDP neighbor cria edge lldp_neighbor com evidência', () => {
  const assets = [{
    id: 'asset-switch',
    primary_ip: '10.0.0.10',
    services: [],
    snmp_neighbors: ['switch-core-1', 'switch-core-2'],
  }];
  const edges = buildTopologyEdges('run-lldp', assets);
  const lldpEdges = edges.filter(e => e.edge_type === 'lldp_neighbor');
  assert.equal(lldpEdges.length, 2, 'deve criar 2 edges LLDP');
  for (const e of lldpEdges) {
    assert.ok(e.confidence > 0.5, 'LLDP deve ter confidence alta (>0.5)');
    assert.ok(e.evidence.length > 0, 'LLDP deve ter evidência');
    assert.ok(e.evidence[0].type === 'snmp_neighbor_discovery');
  }
});

test('topology: CDP neighbor cria edge cdp_neighbor', () => {
  const assets = [{
    id: 'asset-cisco',
    primary_ip: '10.0.0.20',
    services: [],
    snmp_neighbors: ['cdp:core-router-1'],
  }];
  const edges = buildTopologyEdges('run-cdp', assets);
  const cdpEdges = edges.filter(e => e.edge_type === 'cdp_neighbor');
  assert.equal(cdpEdges.length, 1);
  assert.ok(cdpEdges[0].confidence >= 0.82);
});

test('topology: VLAN cria agrupamento lógico com edge vlan_membership', () => {
  const assets = [{
    id: 'asset-vlan',
    primary_ip: '10.0.0.30',
    services: [],
    snmp_vlans: ['10', '20', '99'],
  }];
  const edges = buildTopologyEdges('run-vlan', assets);
  const vlanEdges = edges.filter(e => e.edge_type === 'vlan_membership');
  assert.equal(vlanEdges.length, 3, 'deve criar edge para cada VLAN');
  assert.ok(vlanEdges.every(e => e.to_asset_ref.startsWith('vlan:')));
});

test('topology: SNMP interfaces criam edges snmp_interface', () => {
  const assets = [{
    id: 'asset-ifaces',
    primary_ip: '10.0.0.40',
    services: [],
    snmp_interfaces: [
      { ifIndex: 1, ifName: 'eth0' },
      { ifIndex: 2, ifName: 'eth1' },
    ],
  }];
  const edges = buildTopologyEdges('run-ifaces', assets);
  const ifaceEdges = edges.filter(e => e.edge_type === 'snmp_interface');
  assert.equal(ifaceEdges.length, 2);
  assert.ok(ifaceEdges[0].evidence[0].ifIndex);
});

test('topology: correlação ARP cria edge arp_correlation', () => {
  const assets = [{
    id: 'asset-arp',
    primary_ip: '10.0.0.50',
    mac_address: 'aa:bb:cc:dd:ee:ff',
    services: [],
  }];
  const edges = buildTopologyEdges('run-arp', assets);
  const arpEdges = edges.filter(e => e.edge_type === 'arp_correlation');
  assert.equal(arpEdges.length, 1);
  assert.equal(arpEdges[0].to_asset_ref, 'arp:aa:bb:cc:dd:ee:ff');
  assert.ok(arpEdges[0].evidence[0].mac === 'aa:bb:cc:dd:ee:ff');
});

test('topology: porta isolada NÃO cria edge definitivo sem contexto', () => {
  // Sem MAC, sem SNMP, sem services — nenhuma topologia deve ser gerada
  const assets = [{ id: 'bare', primary_ip: '10.0.0.99', services: [] }];
  const edges = buildTopologyEdges('run-bare', assets);
  assert.equal(edges.length, 0, 'sem services/snmp/mac não deve gerar edges');
});
