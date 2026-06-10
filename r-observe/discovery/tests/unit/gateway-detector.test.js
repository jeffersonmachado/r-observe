'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getLocalIps, detectGateway } = require('../../src/utils/gateway-detector');

test('getLocalIps: retorna array de IPs locais', () => {
  const ips = getLocalIps();
  assert.ok(Array.isArray(ips));
  // Deve ter pelo menos um IP (loopback não conta, mas a interface real sim)
  // Em ambiente de teste pode não ter — mas a função não deve lançar erro
});

test('detectGateway: retorna estrutura completa', () => {
  const gw = detectGateway();
  assert.ok(gw);
  assert.ok(Array.isArray(gw.gateways));
  assert.ok(Array.isArray(gw.local_ips));
  assert.equal(typeof gw.isGateway, 'function');
  assert.equal(typeof gw.isLocalhost, 'function');
});

test('detectGateway: isGateway e isLocalhost são funções válidas', () => {
  const gw = detectGateway();
  // IPs que não são gateway/localhost retornam false
  assert.equal(gw.isGateway('10.255.255.255'), false);
  assert.equal(gw.isLocalhost('10.255.255.255'), false);
  // Localhost loopback
  assert.equal(gw.isLocalhost('127.0.0.1'), true);
  // Gateway e localhost não são o mesmo
  for (const g of gw.gateways) {
    assert.equal(gw.isGateway(g.ip), true);
  }
});

test('detectGateway: local_ips contém IPs válidos', () => {
  const ips = getLocalIps();
  for (const ip of ips) {
    assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  }
});
