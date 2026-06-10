'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('index da API discovery contem endpoints obrigatorios', () => {
  const p = path.resolve(__dirname, '../../src/index.js');
  const code = fs.readFileSync(p, 'utf8');
  const required = [
    "/api/discovery/scan",
    "/api/discovery/runs",
    "/api/discovery/assets",
    "/api/discovery/findings",
    "/api/discovery/topology",
    "/api/discovery/fingerprints",
    "/api/discovery/policies",
    "/api/discovery/history",
    "/api/discovery/passive/events",
    "/api/discovery/prometheus/http-sd",
  ];
  for (const endpoint of required) {
    assert.ok(code.includes(endpoint), `endpoint ausente: ${endpoint}`);
  }
});

test('endpoints de dados da UI discovery exigem autenticação interna', () => {
  const p = path.resolve(__dirname, '../../src/index.js');
  const code = fs.readFileSync(p, 'utf8');
  assert.match(code, /app\.get\('\/observe\/discovery\/data\/summary', requireAuth,/);
  assert.match(code, /app\.get\('\/observe\/discovery\/data\/scopes', requireAuth,/);
});
