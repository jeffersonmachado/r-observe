'use strict';

// JWT_SECRET precisa estar definido antes do require do middleware
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const { createAuthMiddleware } = require('../src/middleware/auth');

function mockDb(rows = []) {
  return {
    async query(_sql, _params) {
      return { rows, rowCount: rows.length };
    },
  };
}

function mockReq(opts = {}) {
  return {
    headers: {
      cookie: opts.cookie || '',
      'x-internal-token': opts.token,
      authorization: opts.authHeader,
      'x-forwarded-proto': opts.proto || 'https',
    },
    ip: opts.ip || '10.0.0.1',
    socket: opts.socket || { remoteAddress: '10.0.0.1' },
    secure: opts.secure ?? true,
  };
}

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.headers = {};
  res.cookie = (_name, _val, _opts) => {};
  res.clearCookie = (_name, _opts) => {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => data;
  return res;
}

function mockLog() {
  return () => {};
}

describe('Auth Middleware', () => {
  let auth;
  const JWT_SECRET = 'test-token-secret';
  const SESSION_COOKIE = 'observe_session';

  beforeEach(() => {
    auth = createAuthMiddleware(mockDb(), JWT_SECRET, SESSION_COOKIE, mockLog());
  });

  it('requireAuth retorna 401 sem token nem sessao', async () => {
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;

    await auth.requireAuth(req, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  it('requireAuth aceita JWT_SECRET raw', async () => {
    const req = mockReq({ token: JWT_SECRET });
    const res = mockRes();
    let nextCalled = false;

    await auth.requireAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.auth.type, 'token');
    assert.equal(req.auth.role, 'admin');
  });

  it('requireAuth aceita JWT_SECRET via Bearer', async () => {
    const req = mockReq({ authHeader: `Bearer ${JWT_SECRET}` });
    const res = mockRes();
    let nextCalled = false;

    await auth.requireAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.auth.type, 'token');
    assert.equal(req.auth.role, 'admin');
  });

  it('requireAuth rejeita token invalido', async () => {
    const req = mockReq({ token: 'wrong-token' });
    const res = mockRes();
    let nextCalled = false;

    await auth.requireAuth(req, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  it('requireAuth aceita sessao valida', async () => {
    const db = mockDb([{ username: 'ops', role: 'operator', expires_at: new Date(Date.now() + 3600000) }]);
    const localAuth = createAuthMiddleware(db, JWT_SECRET, SESSION_COOKIE, mockLog());

    // sessionHash do token 'valid-session-token' precisa bater com o que está no mock
    const crypto = require('crypto');
    const token = 'valid-session-token';
    const hash = crypto.createHash('sha256').update(token).digest('hex');

    const dbWithHash = {
      async query(sql, params) {
        if (sql.includes('token_hash')) {
          if (params[0] === hash) return { rows: [{ username: 'ops', role: 'operator', expires_at: new Date(Date.now() + 3600000) }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const authWithSession = createAuthMiddleware(dbWithHash, JWT_SECRET, SESSION_COOKIE, mockLog());
    const req = mockReq({ cookie: `${SESSION_COOKIE}=${token}` });
    const res = mockRes();
    let nextCalled = false;

    await authWithSession.requireAuth(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.auth.type, 'session');
    assert.equal(req.auth.user, 'ops');
    assert.equal(req.auth.role, 'operator');
  });

  it('requireRole admin bloqueia operator', () => {
    const middleware = auth.requireRole('admin');
    const req = { auth: { type: 'session', user: 'ops', role: 'operator' } };
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('requireRole admin permite admin', () => {
    const middleware = auth.requireRole('admin');
    const req = { auth: { type: 'token', user: 'admin', role: 'admin' } };
    const res = mockRes();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
  });

  it('parseCookies extrai cookies corretamente', () => {
    const result = auth.parseCookies('observe_session=abc123; other=value');
    assert.equal(result['observe_session'], 'abc123');
    assert.equal(result['other'], 'value');
  });

  it('parseCookies lida com header vazio', () => {
    const result = auth.parseCookies('');
    assert.deepEqual(Object.keys(result), []);
  });

  it('sessionHash gera hash consistente', () => {
    const h1 = auth.sessionHash('token1');
    const h2 = auth.sessionHash('token1');
    const h3 = auth.sessionHash('token2');
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.equal(h1.length, 64); // SHA-256 hex
  });

  it('requireAdmin e alias de requireRole("admin")', () => {
    const req = { auth: { type: 'token', user: 'admin', role: 'admin' } };
    const res = mockRes();
    let nextCalled = false;

    auth.requireAdmin(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});
