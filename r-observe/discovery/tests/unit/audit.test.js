'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { logAudit, matchRoute } = require('../../src/audit');

describe('Discovery administrative audit log', () => {
  it('maps every specialized mutable operation', () => {
    assert.equal(matchRoute('POST', '/api/discovery/snmp/deep/router-01').action, 'snmp.deep.scan');
    assert.equal(matchRoute('POST', '/api/discovery/ipam/subnets').action, 'ipam.subnet.create');
    assert.equal(matchRoute('POST', '/api/discovery/alerts/alert-01/acknowledge').action, 'alert.acknowledge');
    assert.equal(matchRoute('POST', '/api/discovery/config-backup/switch-01').action, 'config.backup');
  });

  it('persists the authenticated identity instead of request-controlled tenant data', async () => {
    let values;
    const db = {
      async query(_sql, params) { values = params; return { rowCount: 1 }; },
    };
    const req = {
      method: 'POST',
      path: '/api/discovery/config-backup/switch-01',
      auth: { user: 'discovery-admin', role: 'admin', tenantId: 'trusted-tenant' },
      _auditMeta: { actor_ip: '127.0.0.1' },
      body: { tenant_id: 'untrusted-tenant', ssh_password: 'must-not-leak' },
      query: {},
      params: { host: 'switch-01' },
    };

    await logAudit(db, req);

    assert.equal(values[0], 'trusted-tenant');
    assert.equal(values[3], 'discovery-admin');
    assert.equal(values[6], 'config.backup');
    assert.equal(values[8], 'switch-01');
    assert.equal(JSON.parse(values[11]).body.ssh_password, '***REDACTED***');
  });
});
