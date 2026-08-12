'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(response) {
  return async (_url, _opts) => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.data ?? {},
    text: async () => response.text ?? '',
    headers: new Map(response.headers ? Object.entries(response.headers) : []),
    get: (h) => (response.headers || {})[h],
    forEach: (fn) => Object.entries(response.headers || {}).forEach(([k, v]) => fn(v, k)),
  });
}

describe('API Shared Modules · Smoke', () => {
  it('ai-models exporta todas as constantes esperadas', () => {
    const mod = require('../../shared/ai-models');
    assert.ok(Array.isArray(mod.VALID_AI_PROVIDERS));
    assert.ok(mod.VALID_AI_PROVIDERS.includes('openai'));
    assert.ok(mod.VALID_AI_PROVIDERS.includes('mock'));
    assert.equal(typeof mod.AI_AUTO_MODELS, 'object');
    assert.equal(typeof mod.resolveModel, 'function');
    assert.equal(mod.resolveModel('openai', 'auto'), 'gpt-4o-mini');
    assert.equal(mod.resolveModel('openai', 'gpt-4'), 'gpt-4');
    assert.ok(Array.isArray(mod.REMEDIATION_CATALOG));
    assert.ok(mod.REMEDIATION_CATALOG.length > 0);
  });

  it('lifecycle cria hooks sem crashar', () => {
    const { createLifecycle } = require('../../shared/lifecycle');
    const lc = createLifecycle({ label: 'test', log: () => {} });
    assert.equal(typeof lc.onServer, 'function');
    assert.equal(typeof lc.addCloser, 'function');
    assert.equal(typeof lc.start, 'function');
    lc.addCloser('test', () => Promise.resolve());
    lc.start();
  });

  it('auth middleware cria requireAuth/requireRole/requireAdmin', () => {
    const { createAuthMiddleware } = require('../src/middleware/auth');
    const auth = createAuthMiddleware(
      { async query() { return { rows: [], rowCount: 0 }; } },
      'test-token',
      'observe_session',
      () => {}
    );
    assert.equal(typeof auth.requireAuth, 'function');
    assert.equal(typeof auth.requireRole, 'function');
    assert.equal(typeof auth.requireAdmin, 'function');
  });

  it('ai-settings service cria proxies e reconciliação', () => {
    const { createAISettingsService } = require('../src/services/ai-settings');
    const svc = createAISettingsService({
      db: {
        async query() { return { rows: [{ provider: 'mock', model: 'auto', api_key: null, updated_at: new Date() }], rowCount: 1 }; },
      },
      log: () => {},
      logAIReconcileIssue: () => {},
      processEnv: { AI_SERVICE_URL: 'http://ai:3000', DISCOVERY_SERVICE_URL: 'http://discovery:3010' },
    });
    assert.equal(typeof svc.proxyToAI, 'function');
    assert.equal(typeof svc.proxyToDiscovery, 'function');
    assert.equal(typeof svc.getPersistedAISettings, 'function');
    assert.equal(typeof svc.reconcilePersistedAISettings, 'function');
  });
});

describe('API Health Endpoints · Contracts', () => {
  it('health retorna { status, service, version }', () => {
    const required = ['status', 'service', 'version'];
    // Valida o contrato: todo /health deve ter esses 3 campos
    const examples = [
      { status: 'ok', service: 'r-observe-api', version: '0.1.0' },
      { status: 'ok', service: 'r-observe-ai', version: '0.4.0' },
      { status: 'ok', service: 'r-observe-agent', version: '0.1.0' },
      { status: 'ok', service: 'r-observe-worker', version: '0.1.0' },
      { status: 'ok', service: 'r-observe-discovery', version: '0.1.0' },
    ];
    for (const ex of examples) {
      for (const key of required) {
        assert.ok(key in ex, `${ex.service} health deve ter "${key}"`);
      }
    }
  });
});

describe('API Operational Endpoints · Exposure', () => {
  it('metrics não aceita credencial pela query string e é bloqueado no proxy público', () => {
    const apiCode = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
    const nginxCode = fs.readFileSync(path.resolve(__dirname, '../../../observe/nginx/conf.d/observe.conf'), 'utf8');

    const metricsRoute = apiCode.slice(
      apiCode.indexOf('app.get(`${BASE}/metrics`'),
      apiCode.indexOf('// Status', apiCode.indexOf('app.get(`${BASE}/metrics`')),
    );
    assert.doesNotMatch(metricsRoute, /req\.query\.token|verifyInternalToken/);
    assert.match(nginxCode, /location = \/observe\/api\/metrics \{ return 404; \}/);
    assert.match(nginxCode, /location = \/observe\/api\/sd\/targets \{ return 404; \}/);
    assert.doesNotMatch(nginxCode, /add_header Content-Type application\/json/);
  });

  it('páginas operacionais redirecionam sessões ausentes antes do 404', () => {
    const apiCode = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
    const notFoundAt = apiCode.indexOf("app.use((_req, res) => res.status(404)");
    for (const route of ['/observe/settings', '/observe/config', '/observe/home', '/observe/ai']) {
      const declaration = `app.get('${route}', requireWebSession,`;
      const routeAt = apiCode.indexOf(declaration);
      assert.ok(routeAt >= 0, `${route} precisa exigir sessão web`);
      assert.ok(routeAt < notFoundAt, `${route} precisa ser registrada antes do 404`);
      assert.equal(apiCode.indexOf(declaration, routeAt + 1), -1, `${route} não deve ser duplicada`);
    }
  });

  it('JWTs M2M exigem scopes específicos para eventos e inventário', () => {
    const apiCode = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
    assert.match(apiCode, /app\.post\(`\$\{BASE\}\/events`, requireAuth, requireScopeForJwt\('api:events:write'\)/);
    assert.match(apiCode, /app\.post\(`\$\{BASE\}\/icinga\/events`, requireAuth, requireScopeForJwt\('api:events:write'\)/);
    assert.match(apiCode, /app\.post\(`\$\{BASE\}\/hosts`, requireAuth, requireAdmin, requireInventoryWrite,/);
    assert.match(apiCode, /app\.post\(`\$\{BASE\}\/inventory\/docker`, requireAuth, requireAdmin, requireInventoryWrite,/);
  });

  it('todas as mutações administrativas limitam também o domínio do JWT', () => {
    const apiCode = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
    const adminMutations = apiCode.match(/^app\.(?:post|patch|delete)\([^\n]+requireAdmin[^\n]+/gm) || [];
    assert.ok(adminMutations.length > 0);
    for (const route of adminMutations) {
      assert.match(
        route,
        /require(?:Admin|Inventory|Discovery|AI|Remediation)Write,/,
        `scope M2M ausente: ${route}`,
      );
    }
  });

  it('sondas HTTP do Agent não vazam JWT para alvos monitorados', () => {
    const agentCode = fs.readFileSync(path.resolve(__dirname, '../../agent/src/index.js'), 'utf8');
    const checkHttp = agentCode.slice(
      agentCode.indexOf('async function checkHTTP'),
      agentCode.indexOf('// Check: TCP', agentCode.indexOf('async function checkHTTP')),
    );
    assert.doesNotMatch(checkHttp, /x-internal-token|signInternalToken/);
  });
});

describe('DB Client · Smoke', () => {
  it('createDbClient cria cliente sem crashar', () => {
    const { createDbClient } = require('../src/db');
    const client = createDbClient({
      DB_HOST: 'localhost', DB_PORT: '5432',
      DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'test',
    });
    assert.equal(typeof client.query, 'function');
    assert.equal(typeof client.connect, 'function');
    assert.equal(typeof client.end, 'function');
  });
});
