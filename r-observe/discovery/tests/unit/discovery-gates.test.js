'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprintAsset } = require('../../src/fingerprint/engine');
const { buildTopologyEdges } = require('../../src/topology/engine');

const fingerprintFixtures = [
  { name: 'Apache', input: { http_server: 'Apache/2.4.58', open_ports: [80], http_title: 'Apache default site' }, product: 'Apache', category: 'web' },
  { name: 'Nginx', input: { http_server: 'nginx/1.25.3', open_ports: [443], tls_subject: 'CN=nginx.local' }, product: 'Nginx', category: 'web' },
  { name: 'PostgreSQL', input: { open_ports: [5432], smtp_banner: 'PostgreSQL server ready', history: { asset_key_match: true, previous_asset_type: 'database', previous_technology: 'postgres' } }, product: 'PostgreSQL', category: 'database' },
  { name: 'Prometheus', input: { open_ports: [9090], http_title: 'Prometheus Time Series Collection and Processing Server' }, product: 'Prometheus', category: 'observability' },
  { name: 'Grafana', input: { open_ports: [3000], http_title: 'Grafana', http_server: 'nginx reverse proxy grafana' }, product: 'Grafana', category: 'observability' },
  { name: 'ControlID FaceID', input: { onvif_probe: { responded: true, device_info: true, model: 'ControlID FaceID iDProx' }, open_ports: [80] }, product: 'ControlID FaceID', category: 'iot', productMode: 'includes' },
  { name: 'Grandstream', input: { snmp_sysdescr: 'Grandstream GXV3275', open_ports: [5060], sip_probe: { responded: true, status: 200, user_agent: 'Grandstream SIP UA' }, topology: { vlan_role: 'voice' } }, product: 'Grandstream', category: 'voice', productMode: 'includes' },
  { name: 'Mikrotik', input: { snmp_sysdescr: 'Mikrotik RouterOS', open_ports: [80], topology: { gateway: true } }, product: 'Mikrotik', category: 'router' },
  { name: 'Hikvision', input: { snmp_sysdescr: 'Hikvision Camera', open_ports: [554], rtsp_probe: { responded: true, status: 200, server: 'Hikvision RTSP' }, onvif_probe: { responded: true, device_info: true, model: 'Hikvision Camera' }, topology: { poe: true } }, product: 'Hikvision', category: 'iot', productMode: 'includes' },
  { name: 'Intelbras', input: { snmp_sysdescr: 'Intelbras DVR', open_ports: [80, 554], rtsp_probe: { responded: true, status: 200, server: 'Intelbras RTSP' }, onvif_probe: { responded: true, device_info: true, model: 'Intelbras DVR' } }, product: 'Intelbras', category: 'iot', productMode: 'includes' },
];

for (const fx of fingerprintFixtures) {
  test(`fingerprint fixture: ${fx.name}`, () => {
    const fp = fingerprintAsset(fx.input);
    if (fx.productMode === 'includes') assert.ok(fp.product.includes(fx.product));
    else assert.equal(fp.product, fx.product);
    assert.equal(fp.category, fx.category);
    assert.equal(typeof fp.vendor, 'string');
    assert.equal(typeof fp.confidence, 'number');
    assert.ok(fp.confidence >= 0.31);
    assert.ok(Array.isArray(fp.evidence));
    assert.ok(fp.evidence_count >= 2);
  });
}

test('topology: host -> service, service -> db/dns/exporter e container -> service', () => {
  const edges = buildTopologyEdges('run-xyz', [
    {
      id: 'asset-1',
      primary_ip: '10.10.2.55',
      services: [
        { port: 5432, protocol: 'tcp', dependency_target: '10.10.2.99:5432', container_id: 'abc123' },
        { port: 53, protocol: 'udp' },
        { port: 9100, protocol: 'tcp' },
      ],
    },
  ]);

  assert.ok(edges.find((e) => e.edge_type === 'host_service' && e.to_asset_ref === '10.10.2.55:5432'));
  assert.ok(edges.find((e) => e.edge_type === 'service_database'));
  assert.ok(edges.find((e) => e.edge_type === 'service_dns'));
  assert.ok(edges.find((e) => e.edge_type === 'service_exporter'));
  assert.ok(edges.find((e) => e.edge_type === 'container_service' && e.to_asset_ref === 'container:abc123'));
});

test('topology: deduplicação de edges', () => {
  const edges = buildTopologyEdges('run-dup', [
    {
      id: 'asset-dup',
      primary_ip: '10.10.2.77',
      services: [
        { port: 3306, protocol: 'tcp', dependency_target: '10.10.2.99:3306' },
        { port: 3306, protocol: 'tcp', dependency_target: '10.10.2.99:3306' },
      ],
    },
  ]);

  const uniqueKeys = new Set(edges.map((e) => `${e.from_asset_id}|${e.to_asset_ref}|${e.edge_type}|${e.protocol}`));
  assert.equal(uniqueKeys.size, edges.length);
});
