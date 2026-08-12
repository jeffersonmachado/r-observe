'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
  ROUTE_ACTIONS,
  canonicalAuditPath,
  createAuditMiddleware,
  logAudit,
  matchRoute,
  stripSensitive,
} = require('../src/audit');

describe('Administrative audit log', () => {
  it('maps critical mutable routes including parameterized resources', () => {
    assert.equal(matchRoute('POST', '/observe/api/contacts').action, 'contact.create');
    assert.equal(matchRoute('DELETE', '/observe/api/hosts/node-01').action, 'host.delete');
    assert.equal(matchRoute('PATCH', '/observe/api/discovery/targets/target-01').action, 'discovery.target.update');
    assert.equal(matchRoute('POST', '/observe/api/remediation/rem-01/approve').action, 'remediation.approve');
    assert.ok(Object.keys(ROUTE_ACTIONS).length >= 20);
  });

  it('normalizes a custom API base path for route matching', () => {
    assert.equal(canonicalAuditPath('/internal/observe/contacts', '/internal/observe'), '/observe/api/contacts');
  });

  it('redacts sensitive values recursively without mutating input', () => {
    const source = { provider: 'openai', api_key: 'secret-value', nested: { password: 'hidden' } };
    const clean = stripSensitive(source);
    assert.equal(clean.api_key, '***REDACTED***');
    assert.equal(clean.nested.password, '***REDACTED***');
    assert.equal(source.api_key, 'secret-value');
  });

  it('persists the authenticated actor and tenant at response time', async () => {
    let statement;
    let values;
    const db = {
      async query(sql, params) { statement = sql; values = params; return { rowCount: 1 }; },
    };
    const req = {
      method: 'POST',
      path: '/observe/api/ai/settings',
      originalUrl: '/observe/api/ai/settings',
      auth: { user: 'automation-ci', role: 'admin', tenantId: 'tenant-ci' },
      _auditAction: matchRoute('POST', '/observe/api/ai/settings'),
      _auditMeta: { actor_ip: '127.0.0.1' },
      body: { provider: 'mock', api_key: 'must-not-leak' },
      query: {},
      params: {},
    };
    await logAudit(db, req, { response_status: 200 });
    assert.match(statement, /INSERT INTO observe_audit_log/);
    assert.equal(values[0], 'tenant-ci');
    assert.equal(values[3], 'automation-ci');
    assert.equal(values[4], 'admin');
    assert.equal(JSON.parse(values[11]).body.api_key, '***REDACTED***');
  });

  it('automatically audits only successful responses after authentication', async () => {
    const writes = [];
    const db = {
      async query(_sql, params) { writes.push(params); return { rowCount: 1 }; },
    };
    const middleware = createAuditMiddleware(db, () => {});

    const successfulReq = {
      method: 'POST',
      path: '/observe/api/contacts',
      originalUrl: '/observe/api/contacts',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      body: { name: 'operations' },
      query: {},
      params: {},
    };
    const successfulRes = new EventEmitter();
    successfulRes.statusCode = 201;
    middleware(successfulReq, successfulRes, () => {
      successfulReq.auth = { user: 'admin-ci', role: 'admin', tenantId: 'tenant-ci' };
    });
    successfulRes.emit('finish');
    await new Promise((resolve) => setImmediate(resolve));

    const rejectedReq = {
      method: 'DELETE',
      path: '/observe/api/hosts/node-01',
      originalUrl: '/observe/api/hosts/node-01',
      headers: {},
      socket: {},
      body: {},
      query: {},
      params: { name: 'node-01' },
    };
    const rejectedRes = new EventEmitter();
    rejectedRes.statusCode = 403;
    middleware(rejectedReq, rejectedRes, () => {});
    rejectedRes.emit('finish');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 'tenant-ci');
    assert.equal(writes[0][3], 'admin-ci');
    assert.equal(writes[0][6], 'contact.create');
  });
});
