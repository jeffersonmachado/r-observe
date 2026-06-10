'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferAsset, extractEvidence } = require('../../src/inference/engine');

test('evidence engine normaliza evidencias com schema obrigatorio', () => {
  const evidence = extractEvidence({
    open_ports: [554],
    rtsp_probe: { responded: true, status: 200, server: 'Dahua RTSP' },
    onvif_probe: { responded: true, device_info: true, model: 'Dahua IPC-HFW' },
  });
  assert.ok(evidence.length >= 3);
  for (const item of evidence) {
    assert.equal(typeof item.evidence_type, 'string');
    assert.equal(typeof item.evidence_source, 'string');
    assert.equal(typeof item.confidence, 'number');
    assert.ok(item.timestamp);
    assert.ok(Object.prototype.hasOwnProperty.call(item, 'raw_data'));
    assert.ok(Object.prototype.hasOwnProperty.call(item, 'normalized_data'));
  }
});

test('porta SIP isolada e apenas sinal fraco', () => {
  const out = inferAsset({ open_ports: [5060] });
  assert.equal(out.asset_type, 'host');
  assert.equal(out.technology, 'unknown');
  assert.equal(out.governance.decision, 'REVIEW_PENDING');
  assert.ok(out.confidence_score < 0.5);
});

test('porta RTSP isolada nao classifica camera', () => {
  const out = inferAsset({ open_ports: [554] });
  assert.equal(out.asset_type, 'host');
  assert.equal(out.technology, 'unknown');
  assert.equal(out.governance.decision, 'REVIEW_PENDING');
  assert.ok(out.confidence_score < 0.5);
});

test('porta PostgreSQL isolada nao classifica database', () => {
  const out = inferAsset({ open_ports: [5432] });
  assert.equal(out.asset_type, 'host');
  assert.equal(out.technology, 'unknown');
  assert.equal(out.governance.decision, 'REVIEW_PENDING');
  assert.ok(out.confidence_score < 0.5);
});

test('banner isolado nao classifica produto com alta confianca', () => {
  const out = inferAsset({ http_server: 'nginx' });
  assert.notEqual(out.confidence_level, 'high');
  assert.equal(out.governance.auto_approve, false);
});

test('correlacao topology-aware aumenta confidence de camera IP', () => {
  const withoutTopology = inferAsset({
    open_ports: [554],
    rtsp_probe: { responded: true, status: 200, server: 'ONVIF RTSP' },
    onvif_probe: { responded: true, device_info: true, model: 'ONVIF IPC' },
  });
  const withTopology = inferAsset({
    open_ports: [554],
    rtsp_probe: { responded: true, status: 200, server: 'ONVIF RTSP' },
    onvif_probe: { responded: true, device_info: true, model: 'ONVIF IPC' },
    topology: { poe: true, edge_port: true },
  });
  assert.equal(withTopology.asset_type, 'camera_ip');
  assert.ok(withTopology.confidence_score > withoutTopology.confidence_score);
});

test('voice vlan e SIP OPTIONS correlacionam endpoint de voz', () => {
  const out = inferAsset({
    open_ports: [5060],
    sip_probe: { responded: true, status: 200, user_agent: 'Grandstream GXP SIP UA' },
    topology: { vlan_role: 'voice', edge_port: true },
  });
  assert.equal(out.asset_type, 'voice_endpoint');
  assert.equal(out.category, 'voice');
  assert.ok(out.confidence_score >= 0.6);
});

test('historico preserva identidade com decay controlado', () => {
  const recent = inferAsset({
    open_ports: [80],
    http_server: 'nginx',
    history: { asset_key_match: true, previous_asset_type: 'web_service', previous_technology: 'nginx', age_days: 1 },
  });
  const stale = inferAsset({
    open_ports: [80],
    http_server: 'nginx',
    history: { asset_key_match: true, previous_asset_type: 'web_service', previous_technology: 'nginx', age_days: 120 },
  });
  assert.equal(recent.asset_type, 'web_service');
  assert.ok(recent.confidence_score > stale.confidence_score);
});

test('conflitos bloqueiam aprovacao automatica', () => {
  const out = inferAsset({
    open_ports: [554, 5060],
    rtsp_probe: { responded: true, status: 200, server: 'ONVIF RTSP' },
    onvif_probe: { responded: true, device_info: true, model: 'ONVIF IPC' },
    sip_probe: { responded: true, status: 200, user_agent: 'Yealink SIP UA' },
    topology: { poe: true, vlan_role: 'voice', edge_port: true },
  });
  assert.ok(out.conflicting_evidence > 0);
  assert.equal(out.governance.decision, 'REVIEW_PENDING');
});
