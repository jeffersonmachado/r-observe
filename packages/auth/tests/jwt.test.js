'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const jwt = require('jsonwebtoken');
const { createJwtHelpers, jwtPayloadToAuth, hasScopes, requireScope, requireScopeForJwt } = require('../src');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function helpers(overrides = {}) {
  return createJwtHelpers({
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    JWT_ISSUER: 'r-observe',
    ...overrides,
  });
}

describe('JWT M2M policy', () => {
  it('normalizes JWT claims into the shared request identity', () => {
    assert.deepEqual(jwtPayloadToAuth({
      sub: 'worker', service: 'worker', role: 'operator', scope: ['api:access'], tenant_id: 'tenant-a',
    }), {
      type: 'jwt', user: 'worker', service: 'worker', role: 'operator', scope: ['api:access'], tenantId: 'tenant-a',
    });
  });

  it('enforces route scopes after authentication', () => {
    assert.equal(hasScopes({ scope: ['ai:access', 'ai:settings:write'] }, ['ai:settings:write']), true);
    assert.equal(hasScopes({ scope: ['ai:access'] }, ['ai:settings:write']), false);

    const req = { auth: { scope: ['ai:access'] } };
    const response = {};
    response.status = (code) => { response.statusCode = code; return response; };
    response.json = (body) => body;
    let called = false;
    requireScope('ai:settings:write')(req, response, () => { called = true; });
    assert.equal(response.statusCode, 403);
    assert.equal(called, false);
  });

  it('enforces service scopes for JWT while preserving session RBAC', () => {
    const response = {};
    response.status = (code) => { response.statusCode = code; return response; };
    response.json = (body) => body;
    let sessionCalled = false;
    requireScopeForJwt('api:events:write')(
      { auth: { type: 'session', role: 'admin' } }, response, () => { sessionCalled = true; },
    );
    assert.equal(sessionCalled, true);

    let jwtCalled = false;
    requireScopeForJwt('api:events:write')(
      { auth: { type: 'jwt', scope: ['api:access'] } }, response, () => { jwtCalled = true; },
    );
    assert.equal(jwtCalled, false);
    assert.equal(response.statusCode, 403);
  });

  it('accepts matching issuer, audience and required scope', () => {
    const signer = helpers();
    const verifier = helpers({ JWT_AUDIENCE: 'api', JWT_REQUIRED_SCOPES: 'api:access' });
    const token = signer.signInternalToken({ aud: 'api', scope: ['api:access'] });

    assert.equal(verifier.verifyInternalToken(token).aud, 'api');
  });

  it('rejects a valid token intended for another service', () => {
    const token = helpers().signInternalToken({ aud: 'ai', scope: ['ai:access'] });
    const api = helpers({ JWT_AUDIENCE: 'api', JWT_REQUIRED_SCOPES: 'api:access' });

    assert.equal(api.verifyInternalToken(token), null);
  });

  it('rejects a token without every required scope', () => {
    const token = helpers().signInternalToken({ aud: 'api', scope: ['metrics:read'] });
    const api = helpers({ JWT_AUDIENCE: 'api', JWT_REQUIRED_SCOPES: 'api:access audit:read' });

    assert.equal(api.verifyInternalToken(token), null);
  });

  it('accepts the wildcard scope for trusted administrative automation', () => {
    const token = helpers().signInternalToken({ aud: 'api', scope: ['*'] });
    const api = helpers({ JWT_AUDIENCE: 'api', JWT_REQUIRED_SCOPES: 'api:access audit:read' });

    assert.ok(api.verifyInternalToken(token));
  });

  it('rejects a token from another issuer', () => {
    const token = helpers({ JWT_ISSUER: 'foreign-system' }).signInternalToken({
      aud: 'api',
      scope: ['api:access'],
    });
    const api = helpers({ JWT_AUDIENCE: 'api', JWT_REQUIRED_SCOPES: 'api:access' });

    assert.equal(api.verifyInternalToken(token), null);
  });

  it('requires jti and accepts only configured service identities', () => {
    const api = helpers({
      JWT_AUDIENCE: 'api',
      JWT_REQUIRED_SCOPES: 'api:access',
      JWT_ALLOWED_SERVICES: 'agent,automation',
      JWT_REQUIRE_JTI: 'true',
    });
    const agentToken = helpers().signInternalToken({
      service: 'agent', aud: 'api', scope: ['api:access'],
    });
    const workerToken = helpers().signInternalToken({
      service: 'worker', aud: 'api', scope: ['api:access'],
    });
    const tokenWithoutJti = jwt.sign({
      sub: 'legacy', service: 'agent', iss: 'r-observe', aud: 'api', scope: ['api:access'],
    }, privateKey, { algorithm: 'RS256', expiresIn: '5m' });

    assert.ok(api.verifyInternalToken(agentToken).jti);
    assert.equal(api.verifyInternalToken(workerToken), null);
    assert.equal(api.verifyInternalToken(tokenWithoutJti), null);
  });

  it('rejects excessive lifetimes and tokens issued in the future', () => {
    const verifier = helpers({
      JWT_AUDIENCE: 'api',
      JWT_MAX_LIFETIME: '30m',
      JWT_CLOCK_TOLERANCE_SECONDS: '5',
    });
    const longLived = helpers({ JWT_EXPIRY: '2h' }).signInternalToken({ aud: 'api' });
    const now = Math.floor(Date.now() / 1000);
    const issuedInFuture = helpers().signInternalToken({ aud: 'api', iat: now + 60 });

    assert.equal(verifier.verifyInternalToken(longLived), null);
    assert.equal(verifier.verifyInternalToken(issuedInFuture), null);
  });

  it('prevents a signer from escalating service, audience, scope or role', () => {
    const agent = helpers({
      JWT_SIGNING_SERVICE: 'agent',
      JWT_ALLOWED_AUDIENCES: 'api',
      JWT_ALLOWED_SIGNING_SCOPES: 'api:access,api:events:write',
      JWT_MAX_SIGNING_ROLE: 'operator',
    });
    assert.ok(agent.signInternalToken({
      service: 'agent', aud: 'api', role: 'operator', scope: ['api:access'],
    }));
    assert.throws(() => agent.signInternalToken({ service: 'worker', aud: 'api', scope: ['api:access'] }), /service não permitido/);
    assert.throws(() => agent.signInternalToken({ service: 'agent', aud: 'ai', scope: ['api:access'] }), /audience não permitida/);
    assert.throws(() => agent.signInternalToken({ service: 'agent', aud: 'api', scope: ['api:admin:write'] }), /scope não permitido/);
    assert.throws(() => agent.signInternalToken({ service: 'agent', aud: 'api', role: 'admin', scope: ['api:access'] }), /role não permitida/);
  });

  it('selects public keys by kid and binds kid to service', () => {
    const workerKeys = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'results-auth-'));
    const agentPublic = path.join(directory, 'agent.pem');
    const workerPublic = path.join(directory, 'worker.pem');
    fs.writeFileSync(agentPublic, publicKey);
    fs.writeFileSync(workerPublic, workerKeys.publicKey);
    try {
      const verifier = createJwtHelpers({
        JWT_PUBLIC_KEY_FILES: `agent=${agentPublic},worker=${workerPublic}`,
        JWT_ISSUER: 'r-observe', JWT_AUDIENCE: 'api',
      });
      const agent = helpers({ JWT_KEY_ID: 'agent', JWT_SIGNING_SERVICE: 'agent' });
      const valid = agent.signInternalToken({ service: 'agent', aud: 'api' });
      const mismatchedIdentity = jwt.sign({
        sub: 'forged', service: 'worker', iss: 'r-observe', aud: 'api', scope: [],
      }, privateKey, { algorithm: 'RS256', expiresIn: '5m', keyid: 'agent' });
      const unknownKid = jwt.sign({
        sub: 'unknown', service: 'unknown', iss: 'r-observe', aud: 'api', scope: [],
      }, privateKey, { algorithm: 'RS256', expiresIn: '5m', keyid: 'unknown' });

      assert.equal(verifier.verifyInternalToken(valid).service, 'agent');
      assert.equal(verifier.verifyInternalToken(mismatchedIdentity), null);
      assert.equal(verifier.verifyInternalToken(unknownKid), null);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
