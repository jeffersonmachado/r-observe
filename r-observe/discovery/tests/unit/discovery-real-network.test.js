'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferAsset, extractEvidence } = require('../../src/inference/engine');
const { normalizeAsset } = require('../../src/normalizers/asset-normalizer');
const fixtures = require('../fixtures/real-network-data');

// ─── Fixtures reais: normalizar os assets antes de inferir ────────────────

const gatewayNormalized = normalizeAsset(
  fixtures.gatewayArpRaw,
  null,
  { isGateway: true, isLocalhost: false }
);

const appServerNormalized = normalizeAsset(
  fixtures.appServerArpRaw,
  fixtures.appServerNmapScan,
  { isGateway: false, isLocalhost: false }
);

const localhostNormalized = normalizeAsset(
  fixtures.localHostArpRaw,
  null,
  { isGateway: false, isLocalhost: true }
);

// ─── Testes ────────────────────────────────────────────────────────────────

test('CASO 1: MAC localmente administrado não quebra classificação', () => {
  // Gateway tem MAC LAA (02:10:18:5c:5e:4b)
  // Deve ser classificado como gateway, NÃO como "unknown" por causa do MAC
  const evidence = extractEvidence(gatewayNormalized);
  const macEvidence = evidence.find(e => e.evidence_type === 'mac_structure');
  assert.ok(macEvidence);
  assert.equal(macEvidence.normalized_data.mac_type, 'locally_administered');
});

test('CASO 2: MAC com vendor conhecido mas classificação é por serviços, não por vendor', () => {
  const result = inferAsset(appServerNormalized);
  // O vendor é Motorola/Hisense (OUI), mas o asset deve ser classificado
  // pelas portas de app server (8008, 8009, 8443), não como "mobile device"
  assert.notEqual(result.asset_type, 'mobile_device', 'Não deve classificar como mobile pelo vendor Motorola');
  assert.ok(result.confidence_score >= 0.4, 'Deve ter confiança razoável pelas portas');
});

test('CASO 3: Host com 8008, 8009 e 8443 → application_server', () => {
  const result = inferAsset(appServerNormalized);

  assert.equal(result.asset_type, 'application_server');
  assert.ok(result.confidence_score >= 0.48, `Confiança deveria ser >= 0.48, foi ${result.confidence_score}`);
  assert.ok(result.evidence_count >= 5, `Múltiplas evidências esperadas, teve ${result.evidence_count}`);
});

test('CASO 4: Porta 8009 AJP → evidência forte de Tomcat', () => {
  const evidence = extractEvidence(appServerNormalized);
  // A evidência de Tomcat é criada como text_fingerprint com technology: 'tomcat'
  const tomcatEvidence = evidence.filter(e =>
    e.evidence_type === 'text_fingerprint' &&
    e.normalized_data?.technology === 'tomcat'
  );
  assert.ok(tomcatEvidence.length > 0, 'Deve existir pelo menos 1 evidência de Tomcat via porta 8009');
});

test('CASO 5: Gateway identificado corretamente', () => {
  const result = inferAsset(gatewayNormalized);
  assert.equal(result.asset_type, 'gateway');
  assert.ok(result.confidence_score >= 0.70, `Gateway deve ter alta confiança, foi ${result.confidence_score}`);
});

test('CASO 6: Máquina local é classificada como local_host', () => {
  const result = inferAsset(localhostNormalized);
  assert.equal(result.asset_type, 'local_host');
  assert.ok(result.confidence_score >= 0.85, `Localhost deve ter confiança muito alta, foi ${result.confidence_score}`);
});

test('Portas filtered são processadas separadamente', () => {
  const evidence = extractEvidence(appServerNormalized);
  const filteredEvidence = evidence.filter(e => e.evidence_type === 'tcp_filtered_port');
  assert.equal(filteredEvidence.length, 2, 'Deve ter 2 portas filtered');

  const filteredPorts = filteredEvidence.map(e => e.normalized_data.port).sort();
  assert.deepEqual(filteredPorts, [8088, 9001]);
});

test('Portas open e filtered não se misturam', () => {
  const evidence = extractEvidence(appServerNormalized);
  const openEvidence = evidence.filter(e => e.evidence_type === 'tcp_open_port');

  const openPorts = openEvidence.map(e => e.normalized_data.port).sort();
  assert.ok(openPorts.includes(7000));
  assert.ok(openPorts.includes(8008));
  assert.ok(openPorts.includes(8009));
  assert.ok(openPorts.includes(8443));
  assert.ok(openPorts.includes(9000));

  // Nenhuma porta filtered deve aparecer como open
  assert.ok(!openPorts.includes(8088));
  assert.ok(!openPorts.includes(9001));
});

test('Ausência de OS exato não impede classificação', () => {
  // appServerNmapScan tem os_hint: null
  const result = inferAsset(appServerNormalized);
  // Deve classificar mesmo sem OS detection
  assert.notEqual(result.asset_type, 'host');
  assert.notEqual(result.technology, 'unknown');
});

test('Resultado final possui confidence', () => {
  const result = inferAsset(appServerNormalized);
  assert.equal(typeof result.confidence_score, 'number');
  assert.ok(result.confidence_score > 0);
  assert.ok(result.confidence_score <= 1);
  assert.ok(['high', 'medium', 'low', 'insufficient'].includes(result.confidence_level));
});

test('Resultado final possui evidence', () => {
  const result = inferAsset(appServerNormalized);
  assert.ok(Array.isArray(result.evidence));
  assert.ok(result.evidence_count > 0);
  // Cada evidência deve ter os campos obrigatórios
  for (const ev of result.evidence) {
    assert.equal(typeof ev.evidence_type, 'string');
    assert.equal(typeof ev.evidence_source, 'string');
    assert.equal(typeof ev.confidence, 'number');
    assert.ok(ev.timestamp);
    assert.ok(Object.prototype.hasOwnProperty.call(ev, 'raw_data'));
    assert.ok(Object.prototype.hasOwnProperty.call(ev, 'normalized_data'));
  }
});

test('NÃO existe classificação baseada apenas em IP fixo', () => {
  // Testa que a inferência depende de evidências, não de IP hardcoded
  const result1 = inferAsset({ ip: '192.168.0.43', open_ports: [] });
  assert.equal(result1.asset_type, 'host', 'Sem evidências deve cair para host');

  const result2 = inferAsset({ ip: '10.0.0.1', open_ports: [] });
  assert.equal(result2.asset_type, 'host', 'IP diferente, mesmo resultado');

  // IPs diferentes com mesmas evidências devem dar mesmo resultado
  const result3 = inferAsset({
    ...appServerNormalized,
    ip: '10.20.30.43',
  });
  assert.equal(result3.asset_type, 'application_server');
});

test('Gateway com MAC LAA ainda é classificado como gateway', () => {
  // Gateway tem MAC 02:10:18:5c:5e:4b (LAA)
  // Mas é_gateway é true → deve ser gateway
  const result = inferAsset(gatewayNormalized);
  assert.equal(result.asset_type, 'gateway');
  // A confiança deve vir principalmente da evidência topology_context (gateway)
  const topologyEvidence = result.evidence.filter(e =>
    e.evidence_source === 'gateway-detector'
  );
  assert.ok(topologyEvidence.length > 0);
});

test('Candidate scores mostram alternativas de classificação', () => {
  const result = inferAsset(appServerNormalized);
  assert.ok(Array.isArray(result.candidate_scores));
  assert.ok(result.candidate_scores.length > 0);
  // O primeiro deve ser application_server
  assert.equal(result.candidate_scores[0].asset_type, 'application_server');
});

test('application_server stack inference sugere Java/Tomcat', () => {
  const result = inferAsset(appServerNormalized);
  assert.equal(result.asset_type, 'application_server');
  // Verifica que a tecnologia inferida é java ou tomcat
  const techOk = result.technology === 'java' || result.technology === 'tomcat';
  assert.ok(techOk, `Tecnologia deveria ser java ou tomcat, foi ${result.technology}`);
});
