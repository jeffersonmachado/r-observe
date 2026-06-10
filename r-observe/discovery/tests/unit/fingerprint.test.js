'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprintAsset } = require('../../src/fingerprint/engine');

test('fingerprint nao classifica banco apenas por porta', () => {
  const fp = fingerprintAsset({ open_ports: [5432], hostname: 'db-core' });
  assert.equal(fp.product, 'Sem sinal de serviço');
  assert.equal(fp.technology, 'unknown');
  assert.equal(fp.confidence_level, 'insufficient');
  assert.ok(fp.confidence < 0.5);
});

test('fingerprint infere PostgreSQL com evidencias correlacionadas', () => {
  const fp = fingerprintAsset({
    open_ports: [5432],
    hostname: 'db-core',
    smtp_banner: 'PostgreSQL server ready',
    history: { asset_key_match: true, previous_asset_type: 'database', previous_technology: 'postgres', age_days: 2 },
  });
  assert.equal(fp.category, 'database');
  assert.equal(fp.technology, 'postgres');
  assert.equal(fp.criticality, 'high');
  assert.ok(fp.confidence >= 0.31);
  assert.ok(fp.evidence_count >= 3);
});

test('fingerprint usa OUI como evidencia, nao como classificacao absoluta', () => {
  const fp = fingerprintAsset({ open_ports: [80], mac: '3c:5a:b4:11:22:33' });
  assert.equal(fp.vendor, 'Hikvision');
  assert.equal(fp.product, 'Sem sinal de serviço');
  assert.equal(fp.confidence_level, 'insufficient');
});

test('fingerprint infere camera IP por RTSP, ONVIF, OUI e topologia PoE', () => {
  const fp = fingerprintAsset({
    open_ports: [80, 554],
    mac: '3c:5a:b4:11:22:33',
    onvif_probe: { responded: true, device_info: true, manufacturer: 'Hikvision', model: 'Hikvision DS-2CD' },
    rtsp_probe: { responded: true, status: 200, server: 'Hikvision RTSP' },
    mdns_services: ['_rtsp._tcp'],
    topology: { poe: true, edge_port: true },
  });
  assert.equal(fp.asset_type, 'camera_ip');
  assert.equal(fp.category, 'iot');
  assert.equal(fp.vendor, 'Hikvision');
  assert.ok(fp.confidence >= 0.85);
  assert.equal(fp.governance.decision, 'APPROVED');
});

test('fingerprint correlaciona sinais passivos e ativos para media device', () => {
  const fp = fingerprintAsset({
    open_ports: [1900, 5353],
    http_server: 'Platform 1.0 UPnP/1.0 DLNADOC/1.50',
    passive_events: [
      { type: 'ssdp', payload: { raw: 'NOTIFY urn:schemas-upnp-org:device:MediaRenderer:1' } },
      { type: 'mdns', mdns_services: ['_airplay._tcp'], hostname: 'living-room-tv.local' },
    ],
  });
  assert.equal(fp.category, 'media');
  assert.ok(fp.confidence >= 0.5);
  assert.ok(fp.evidence_objects.some((e) => e.evidence_source.startsWith('passive')));
});
