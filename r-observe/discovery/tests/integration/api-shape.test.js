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
  assert.match(code, /app\.get\('\/observe\/discovery\/data\/summary', requireAuthOpt,/);
  assert.match(code, /app\.get\('\/observe\/discovery\/data\/scopes', requireAuthOpt,/);
});

test('discovery delega autenticação JWT ao @results/auth', () => {
  const p = path.resolve(__dirname, '../../src/index.js');
  const code = fs.readFileSync(p, 'utf8');
  assert.match(code, /const \{ requireJwt, requireScope \} = require\('@results\/auth'\)/);
  assert.match(code, /return requireJwt\(req, res,/);
  assert.doesNotMatch(code, /verifyInternalToken/);
});

test('todas as rotas mutáveis exigem discovery:write', () => {
  const p = path.resolve(__dirname, '../../src/index.js');
  const code = fs.readFileSync(p, 'utf8');
  assert.match(code, /const requireWrite = requireScope\('discovery:write'\)/);
  const mutationRoutes = code.match(/^app\.(?:post|patch|delete)\('\/api\/discovery\/[^\n]+/gm) || [];
  assert.ok(mutationRoutes.length > 0);
  for (const route of mutationRoutes) {
    assert.match(route, /requireAuth, requireWrite,/, `scope de escrita ausente: ${route}`);
  }
});

test('UI discovery nunca recebe token interno embutido no HTML', () => {
  const p = path.resolve(__dirname, '../../src/index.js');
  const code = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(code, /discovery-ui|__TOKEN_PLACEHOLDER__/);
  assert.doesNotMatch(code, /h\['x-internal-token'\] = TOKEN/);
});
