'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMac,
  analyzeMacType,
  isLocallyAdministered,
  vendorReliability,
} = require('../../src/utils/mac-utils');

test('normalizeMac: normaliza MAC válido', () => {
  assert.equal(normalizeMac('02:10:18:5c:5e:4b'), '02:10:18:5c:5e:4b');
  assert.equal(normalizeMac('50:BA:02:B0:9C:4A'), '50:ba:02:b0:9c:4a');
  assert.equal(normalizeMac('66-5A-AB-72-63-01'), '66:5a:ab:72:63:01');
});

test('normalizeMac: rejeita MAC inválido', () => {
  assert.equal(normalizeMac(null), null);
  assert.equal(normalizeMac(''), null);
  assert.equal(normalizeMac('not-a-mac'), null);
  assert.equal(normalizeMac('02:10:18:5c:5e'), null);
});

test('analyzeMacType: detecta locally administered (bit 1 = 1)', () => {
  // 02 = 0000 0010 → bit 1 = 1 (LAA)
  const result = analyzeMacType('02:10:18:5c:5e:4b');
  assert.ok(result);
  assert.equal(result.mac_type, 'locally_administered');
  assert.equal(result.is_locally_administered, true);
  assert.equal(result.is_multicast, false);
  assert.equal(result.is_global_unicast, false);

  // 66 = 0110 0110 → bit 1 = 1 (LAA)
  const result2 = analyzeMacType('66:5a:ab:72:63:01');
  assert.equal(result2.mac_type, 'locally_administered');
});

test('analyzeMacType: detecta global unicast', () => {
  // 50 = 0101 0000 → bit 1 = 0, bit 0 = 0
  const result = analyzeMacType('50:BA:02:B0:9C:4A');
  assert.ok(result);
  assert.equal(result.mac_type, 'global_unicast');
  assert.equal(result.is_locally_administered, false);
  assert.equal(result.is_multicast, false);
  assert.equal(result.is_global_unicast, true);
});

test('analyzeMacType: detecta multicast', () => {
  // 01 = 0000 0001 → bit 0 = 1
  const result = analyzeMacType('01:00:5e:00:00:01');
  assert.ok(result);
  assert.equal(result.mac_type, 'multicast');
  assert.equal(result.is_multicast, true);
});

test('isLocallyAdministered: gateway MAC', () => {
  assert.equal(isLocallyAdministered('02:10:18:5c:5e:4b'), true);
});

test('isLocallyAdministered: MAC aleatório de celular', () => {
  assert.equal(isLocallyAdministered('66:5a:ab:72:63:01'), true);
});

test('isLocallyAdministered: MAC global', () => {
  assert.equal(isLocallyAdministered('50:BA:02:B0:9C:4A'), false);
  assert.equal(isLocallyAdministered('00:1B:44:aa:bb:cc'), false);
});

test('vendorReliability: LAA MAC nunca é confiável', () => {
  const result = vendorReliability('02:10:18:5c:5e:4b', 'SomeVendor');
  assert.equal(result.vendor_reliable, false);
  assert.equal(result.mac_type, 'locally_administered');
});

test('vendorReliability: global unicast com vendor conhecido é confiável', () => {
  const result = vendorReliability('00:1B:44:aa:bb:cc', 'MikroTik');
  assert.equal(result.vendor_reliable, true);
  assert.equal(result.mac_type, 'global_unicast');
});

test('vendorReliability: global unicast com vendor desconhecido não é confiável', () => {
  const result = vendorReliability('50:BA:02:B0:9C:4A', null);
  assert.equal(result.vendor_reliable, false);
  assert.equal(result.mac_type, 'global_unicast');
});
