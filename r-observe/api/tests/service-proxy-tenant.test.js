'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createAISettingsService } = require('../src/services/ai-settings');

describe('Internal service proxy tenant propagation', () => {
  it('signs Discovery calls with the authenticated tenant context', async () => {
    let claims;
    const fetchImpl = async () => ({
      status: 200,
      async text() { return '{}'; },
      headers: { forEach() {} },
    });

    const service = createAISettingsService({
      db: {},
      log() {},
      logAIReconcileIssue() {},
      processEnv: { DISCOVERY_SERVICE_URL: 'http://discovery.test' },
      resolveTenantId: () => 'tenant-authenticated',
      signToken(payload) { claims = payload; return 'signed-token'; },
      fetchImpl,
    });

    const result = await service.proxyToDiscovery('/api/discovery/audit');
    assert.equal(result.status, 200);
    assert.equal(claims.aud, 'discovery');
    assert.equal(claims.tenant_id, 'tenant-authenticated');
    assert.ok(!claims.scope.includes('tenant:all'));
  });
});
