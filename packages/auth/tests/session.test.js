'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { SessionManager, createAuthSystem } = require('../src');

function request() {
  return { ip: '127.0.0.1', headers: { 'user-agent': 'test' }, socket: {} };
}

describe('Persistent sessions', () => {
  it('persists before returning and validates through the adapter', async () => {
    let persisted;
    const adapter = {
      async createSession(session) { persisted = session; },
      async findSession(token) { return token === persisted.token ? persisted : null; },
      async updateLastActivity() {},
      async destroySession() {},
    };
    const manager = new SessionManager(adapter, { sessionTTLHours: 1 });
    const session = await manager.createSession('ops', { role: 'operator', tenantId: 'acme' }, request());

    assert.equal(persisted, session);
    assert.equal((await manager.validateSession(session.token)).userSnapshot.tenantId, 'acme');
  });

  it('does not emit a session when persistence fails', async () => {
    const manager = new SessionManager({
      async createSession() { throw new Error('database unavailable'); },
    });
    await assert.rejects(
      manager.createSession('ops', { role: 'operator' }, request()),
      /database unavailable/
    );
  });

  it('binds CSRF to the authenticated session and exempts JWT', () => {
    const adapter = { async findSession() { return null; } };
    const auth = createAuthSystem({ adapter });
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json() {},
    };
    let nextCalled = false;
    auth.requireCsrf({
      method: 'POST',
      auth: { type: 'session', csrfToken: 'server-token' },
      headers: { cookie: 'observe_session_csrf=attacker-token', 'x-csrf-token': 'attacker-token' },
    }, response, () => { nextCalled = true; });
    assert.equal(response.statusCode, 403);
    assert.equal(nextCalled, false);

    auth.requireCsrf({ method: 'POST', auth: { type: 'jwt' }, headers: {} }, response, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});
