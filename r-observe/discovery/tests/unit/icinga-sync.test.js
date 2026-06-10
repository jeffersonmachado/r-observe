'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const { syncDiscoveredToIcinga } = require('../../src/integrations/icinga');

test('syncDiscoveredToIcinga com lista vazia nao depende de rede', async () => {
  const out = await syncDiscoveredToIcinga({
    tenant: { tenant_id: 'default', site_id: 'default-site', edge_id: 'central' },
    assets: [],
  });

  assert.ok(out && typeof out === 'object');
  assert.strictEqual(out.synced, 0);
  assert.strictEqual(out.staged, false);
  assert.strictEqual(out.deployed, false);
});

function mockHttpsRequest(routes, calls) {
  return function request(options, callback) {
    const req = new EventEmitter();
    const chunks = [];

    req.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    req.end = () => {
      const method = options.method || 'GET';
      const path = options.path;
      calls.push({ method, path, body: Buffer.concat(chunks).toString('utf8') });

      const route = routes.find((entry) => entry.method === method && entry.path === path);
      if (!route) {
        req.emit('error', new Error(`Unexpected request: ${method} ${path}`));
        return;
      }

      const res = new EventEmitter();
      res.statusCode = route.status;
      callback(res);
      process.nextTick(() => {
        if (route.body != null) res.emit('data', Buffer.from(typeof route.body === 'string' ? route.body : JSON.stringify(route.body)));
        res.emit('end');
      });
    };
    req.setTimeout = () => {};
    req.on = function on(event, handler) {
      EventEmitter.prototype.on.call(this, event, handler);
      return this;
    };
    return req;
  };
}

test('syncDiscoveredToIcinga atualiza host existente com POST', async () => {
  const calls = [];
  const originalPassword = process.env.ICINGA_API_PASSWORD;
  const originalUser = process.env.ICINGA_API_USER;
  const originalRequest = https.request;

  process.env.ICINGA_API_PASSWORD = 'test';
  process.env.ICINGA_API_USER = 'test';
  https.request = mockHttpsRequest([
    { method: 'POST', path: '/v1/config/stages/_api', status: 200, body: { results: [{ code: 200, package: '_api', stage: 'stage-1' }] } },
    { method: 'POST', path: '/v1/config/stages/_api/stage-1/activate', status: 200, body: { results: [{ code: 200 }] } },
    { method: 'GET', path: '/v1/objects/hosts/existing-host', status: 200, body: { results: [{}] } },
    { method: 'POST', path: '/v1/objects/hosts/existing-host', status: 200, body: { results: [{ code: 200 }] } },
    { method: 'GET', path: '/v1/objects/hosts?attrs=name&attrs=address&attrs=vars', status: 200, body: { results: [] } },
    { method: 'GET', path: '/v1/objects/services?attrs=name&attrs=host_name&attrs=vars', status: 200, body: { results: [] } },
    { method: 'GET', path: '/v1/objects/hostgroups?attrs=name&attrs=vars', status: 200, body: { results: [] } },
  ], calls);

  try {
    const out = await syncDiscoveredToIcinga({
      tenant: { tenant_id: 'default', site_id: 'default-site', edge_id: 'central' },
      assets: [{ asset_name: 'existing-host', display_name: 'Existing Host', primary_ip: '10.0.0.10', lifecycle_state: 'discovered', services: [] }],
      edges: [],
    });

    assert.strictEqual(out.synced, 1);
    assert.strictEqual(out.staged, true);
    assert.strictEqual(out.deployed, true);
    assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/v1/objects/hosts/existing-host'));
    assert.ok(!calls.some((call) => call.method === 'PUT' && call.path === '/v1/objects/hosts/existing-host'));
  } finally {
    https.request = originalRequest;
    process.env.ICINGA_API_PASSWORD = originalPassword;
    process.env.ICINGA_API_USER = originalUser;
  }
});

test('syncDiscoveredToIcinga cria host novo com PUT', async () => {
  const calls = [];
  const originalPassword = process.env.ICINGA_API_PASSWORD;
  const originalUser = process.env.ICINGA_API_USER;
  const originalRequest = https.request;

  process.env.ICINGA_API_PASSWORD = 'test';
  process.env.ICINGA_API_USER = 'test';
  https.request = mockHttpsRequest([
    { method: 'POST', path: '/v1/config/stages/_api', status: 200, body: { results: [{ code: 200, package: '_api', stage: 'stage-2' }] } },
    { method: 'POST', path: '/v1/config/stages/_api/stage-2/activate', status: 200, body: { results: [{ code: 200 }] } },
    { method: 'GET', path: '/v1/objects/hosts/new-host', status: 404, body: { results: [] } },
    { method: 'PUT', path: '/v1/objects/hosts/new-host', status: 200, body: { results: [{ code: 200 }] } },
    { method: 'GET', path: '/v1/objects/hosts?attrs=name&attrs=address&attrs=vars', status: 200, body: { results: [] } },
    { method: 'GET', path: '/v1/objects/services?attrs=name&attrs=host_name&attrs=vars', status: 200, body: { results: [] } },
    { method: 'GET', path: '/v1/objects/hostgroups?attrs=name&attrs=vars', status: 200, body: { results: [] } },
  ], calls);

  try {
    const out = await syncDiscoveredToIcinga({
      tenant: { tenant_id: 'default', site_id: 'default-site', edge_id: 'central' },
      assets: [{ asset_name: 'new-host', display_name: 'New Host', primary_ip: '10.0.0.11', lifecycle_state: 'discovered', services: [] }],
      edges: [],
    });

    assert.strictEqual(out.synced, 1);
    assert.strictEqual(out.staged, true);
    assert.strictEqual(out.deployed, true);
    assert.ok(calls.some((call) => call.method === 'PUT' && call.path === '/v1/objects/hosts/new-host'));
  } finally {
    https.request = originalRequest;
    process.env.ICINGA_API_PASSWORD = originalPassword;
    process.env.ICINGA_API_USER = originalUser;
  }
});
