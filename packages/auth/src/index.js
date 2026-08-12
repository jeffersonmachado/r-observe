'use strict';

/**
 * @results/auth — Módulo de autenticação centralizada.
 *
 * Este pacote encapsula toda a lógica de autenticação, autorização e
 * gerenciamento de sessão do R-Observe.
 *
 * Interface pública:
 *   createAuthSystem({ adapter, config }) → { middleware, routes, sessionManager }
 *
 * O adapter (ex: ObserveAdapter) conecta o sistema de auth à fonte de
 * identidade real (IcingaWeb2 users, PostgreSQL, LDAP, etc.).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ALG = 'RS256';
const DEFAULT_SESSION_TTL_HOURS = 12;
const DEFAULT_JWT_EXPIRY = '5m';

// ─── Utilidades ──────────────────────────────────────────────────────────────

function parseCookies(header = '') {
  return Object.fromEntries(String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      const key = idx >= 0 ? part.slice(0, idx) : part;
      const val = idx >= 0 ? part.slice(idx + 1) : '';
      return [decodeURIComponent(key), decodeURIComponent(val)];
    }));
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isHttpsRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── JWT (service tokens M2M internos) ─────────────────────────────────────

function loadKey(inlineVar, fileVar, env = process.env) {
  const inline = env[inlineVar];
  if (inline && inline.includes('BEGIN')) return inline.replace(/\\n/g, '\n');
  const file = env[fileVar];
  if (file) {
    try { return require('fs').readFileSync(file, 'utf8'); } catch (_) { /* ausente */ }
  }
  return null;
}

function loadPublicKeyring(env = process.env) {
  const entries = String(env.JWT_PUBLIC_KEY_FILES || '').split(',').map((item) => item.trim()).filter(Boolean);
  const keys = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`Entrada JWT_PUBLIC_KEY_FILES inválida: ${entry}`);
    const kid = entry.slice(0, separator).trim();
    const file = entry.slice(separator + 1).trim();
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(kid) || !file) throw new Error(`Entrada JWT_PUBLIC_KEY_FILES inválida: ${entry}`);
    try {
      keys.set(kid, require('fs').readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Chave pública JWT ausente para kid ${kid}: ${error.message}`);
    }
  }
  return keys;
}

function verificationKey(token, fallbackKey, keyring) {
  if (!keyring.size) return { key: fallbackKey, kid: null };
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header?.kid;
  if (!kid || !keyring.has(kid)) return { key: null, kid: null };
  return { key: keyring.get(kid), kid };
}

function jwtPayloadToAuth(payload = {}) {
  return {
    type: 'jwt',
    user: payload.sub || 'internal',
    role: payload.role || 'operator',
    service: payload.service || null,
    scope: payload.scope || null,
    tenantId: payload.tenant_id || payload.tenantId || 'default',
  };
}

function parseScopes(scope) {
  return Array.isArray(scope)
    ? scope.map(String)
    : String(scope || '').split(/[ ,]+/).filter(Boolean);
}

function hasScopes(auth, required = []) {
  const granted = parseScopes(auth?.scope);
  const expected = Array.isArray(required) ? required : [required];
  return granted.includes('*') || expected.every((scope) => granted.includes(scope));
}

function requireScope(...required) {
  return (req, res, next) => {
    if (!req.auth || !hasScopes(req.auth, required)) {
      return res.status(403).json({ error: 'Forbidden', required_scopes: required });
    }
    next();
  };
}

function requireScopeForJwt(...required) {
  return (req, res, next) => {
    if (!req.auth) return res.status(403).json({ error: 'Forbidden', required_scopes: required });
    if (req.auth.type !== 'jwt') return next();
    return requireScope(...required)(req, res, next);
  };
}

function durationSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value).trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!match) throw new Error(`Duração JWT inválida: ${value}`);
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * units[(match[2] || 's').toLowerCase()];
}

function hasValidTokenWindow(payload, maxLifetimeSeconds, clockToleranceSeconds) {
  if (!maxLifetimeSeconds) return true;
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now + clockToleranceSeconds) return false;
  return payload.exp > payload.iat && payload.exp - payload.iat <= maxLifetimeSeconds;
}

function validateSigningClaims(claims, policy) {
  const service = claims.service || policy.service || 'unknown';
  const audience = claims.aud || claims.audience || policy.defaultAudience;
  const scopes = parseScopes(claims.scope);
  if (policy.service && service !== policy.service) {
    throw new Error(`JWT service não permitido para este emissor: ${service}`);
  }
  if (policy.audiences.length && !policy.audiences.includes(audience)) {
    throw new Error(`JWT audience não permitida para este emissor: ${audience || 'ausente'}`);
  }
  const deniedScope = scopes.find((scope) => !policy.scopes.includes(scope));
  if (policy.scopes.length && deniedScope) {
    throw new Error(`JWT scope não permitido para este emissor: ${deniedScope}`);
  }
  const roleRank = { viewer: 0, operator: 1, admin: 2 };
  const role = claims.role || 'operator';
  if (policy.maxRole && (roleRank[role] ?? Number.MAX_SAFE_INTEGER) > roleRank[policy.maxRole]) {
    throw new Error(`JWT role não permitida para este emissor: ${role}`);
  }
  return { service, audience };
}

function signingPolicy(env, defaultAudience) {
  return {
    service: env.JWT_SIGNING_SERVICE || null,
    defaultAudience,
    audiences: String(env.JWT_ALLOWED_AUDIENCES || '').split(/[ ,]+/).filter(Boolean),
    scopes: String(env.JWT_ALLOWED_SIGNING_SCOPES || '').split(/[ ,]+/).filter(Boolean),
    maxRole: env.JWT_MAX_SIGNING_ROLE || null,
  };
}

// ─── Session Manager ─────────────────────────────────────────────────────────

class SessionManager {
  /**
   * @param {object} adapter - Deve implementar:
   *   createSession(session), findSession(token), destroySession(token),
   *   updateLastActivity(token, now)
   * @param {object} options
   */
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.sessionTTL = options.sessionTTLHours || DEFAULT_SESSION_TTL_HOURS;
    this.cookieName = options.cookieName || 'observe_session';
    this.log = options.log || (() => {});

  }

  async init() {
    if (this.adapter.deleteExpiredSessions) await this.adapter.deleteExpiredSessions();
    this.log('info', 'SessionManager initialized (persistent adapter)');
  }

  async createSession(username, userSnapshot, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = generateCsrfToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTTL * 60 * 60 * 1000);

    const session = {
      token,
      csrfToken,
      username,
      userId: userSnapshot.id || username,
      userSnapshot: userSnapshot || {},
      ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
      userAgent: String(req.headers?.['user-agent'] || '').slice(0, 512),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastActivityAt: now.toISOString(),
    };

    // A sessão só é emitida depois de persistida. O adapter armazena apenas o
    // hash do token; o valor bruto existe somente no cookie do cliente.
    await this.adapter.createSession(session);

    return session;
  }

  async validateSession(token) {
    if (!token) return null;
    const session = await this.adapter.findSession(token);
    if (!session) return null;

    if (new Date(session.expiresAt) <= new Date()) {
      await this.adapter.destroySession(token).catch(() => {});
      return null;
    }

    // Atualiza lastActivity (non-blocking)
    const now = new Date().toISOString();
    session.lastActivityAt = now;
    this.adapter.updateLastActivity(token, now).catch(() => {});

    return session;
  }

  async destroySession(token) {
    await this.adapter.destroySession(token);
  }

  setSessionCookie(req, res, session) {
    const secure = isHttpsRequest(req);
    res.cookie(this.cookieName, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      expires: new Date(session.expiresAt),
    });
    // CSRF token em cookie legível por JS (não-httpOnly)
    res.cookie(`${this.cookieName}_csrf`, session.csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure,
      path: '/',
      expires: new Date(session.expiresAt),
    });
  }

  clearSessionCookie(req, res) {
    res.clearCookie(this.cookieName, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttpsRequest(req),
      path: '/',
    });
    res.clearCookie(`${this.cookieName}_csrf`, {
      httpOnly: false,
      sameSite: 'lax',
      secure: isHttpsRequest(req),
      path: '/',
    });
  }

  getActiveSessions() {
    return [];
  }

  async revokeAllForUser(username) {
    if (!this.adapter.revokeAllForUser) throw new Error('Adapter não suporta revogação por usuário');
    await this.adapter.revokeAllForUser(username);
  }
}

// ─── Auth System ─────────────────────────────────────────────────────────────

function createAuthSystem({ adapter, config = {}, log }) {
  const logger = log || (() => {});
  const sessionManager = new SessionManager(adapter, {
    sessionTTLHours: config.sessionTTLHours,
    cookieName: config.sessionCookieName,
    log: logger,
  });

  // Carrega chaves JWT por identidade de serviço.
  const authEnv = config.env || process.env;
  const PRIVATE_KEY = loadKey('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_FILE', authEnv);
  const PUBLIC_KEY = loadKey('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_FILE', authEnv);
  const PUBLIC_KEYRING = loadPublicKeyring(authEnv);
  const issuer = authEnv.JWT_ISSUER || 'r-observe';
  const expectedAudience = authEnv.JWT_AUDIENCE || null;
  const requiredScopes = String(authEnv.JWT_REQUIRED_SCOPES || '').split(/[ ,]+/).filter(Boolean);
  const allowedServices = String(authEnv.JWT_ALLOWED_SERVICES || '').split(/[ ,]+/).filter(Boolean);
  const requireJti = String(authEnv.JWT_REQUIRE_JTI || 'false').toLowerCase() === 'true';
  const maxLifetimeSeconds = durationSeconds(authEnv.JWT_MAX_LIFETIME);
  const clockToleranceSeconds = Number(authEnv.JWT_CLOCK_TOLERANCE_SECONDS || 5);
  const signerPolicy = signingPolicy(authEnv, authEnv.JWT_DEFAULT_AUDIENCE || expectedAudience);
  const keyId = authEnv.JWT_KEY_ID || signerPolicy.service || null;

  // ─── JWT helpers para service tokens ────────────────────────────────────

  function signInternalToken(claims = {}) {
    if (!PRIVATE_KEY) {
      throw new Error('JWT_PRIVATE_KEY ausente: este serviço não pode assinar tokens internos');
    }
    const signingIdentity = validateSigningClaims(claims, signerPolicy);
    const payload = {
      sub: claims.sub || 'r-observe',
      iat: Math.floor(Date.now() / 1000),
      service: signingIdentity.service,
      jti: claims.jti || crypto.randomUUID(),
      iss: claims.iss || issuer,
      aud: signingIdentity.audience || undefined,
      ...claims,
    };
    return jwt.sign(payload, PRIVATE_KEY, {
      algorithm: ALG,
      expiresIn: config.jwtExpiry || DEFAULT_JWT_EXPIRY,
      ...(keyId ? { keyid: keyId } : {}),
    });
  }

  function verifyInternalToken(token) {
    if (!token || (!PUBLIC_KEY && !PUBLIC_KEYRING.size)) return null;
    try {
      const selected = verificationKey(token, PUBLIC_KEY, PUBLIC_KEYRING);
      if (!selected.key) return null;
      const options = { algorithms: [ALG], issuer };
      options.clockTolerance = clockToleranceSeconds;
      if (expectedAudience) options.audience = expectedAudience;
      const payload = jwt.verify(token, selected.key, options);
      const scopes = Array.isArray(payload.scope)
        ? payload.scope.map(String)
        : String(payload.scope || '').split(/[ ,]+/).filter(Boolean);
      if (requiredScopes.some((scope) => !scopes.includes(scope) && !scopes.includes('*'))) return null;
      if (requireJti && !payload.jti) return null;
      if (allowedServices.length && !allowedServices.includes(payload.service)) return null;
      if (!hasValidTokenWindow(payload, maxLifetimeSeconds, clockToleranceSeconds)) return null;
      if (selected.kid && payload.service !== selected.kid) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  // ─── Middleware ─────────────────────────────────────────────────────────

  async function authenticateRequest(req) {
    // 1. Tenta JWT interno (M2M)
    const provided = req.headers['x-internal-token'] ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided) {
      const jwtPayload = verifyInternalToken(provided);
      if (jwtPayload) {
        return jwtPayloadToAuth(jwtPayload);
      }
      // Token apresentado porém inválido → falha-fechado
      return null;
    }

    // 2. Tenta session cookie (browser)
    const token = parseCookies(req.headers.cookie)[sessionManager.cookieName];
    if (token) {
      const session = await sessionManager.validateSession(token);
      if (session) {
        return {
          type: 'session',
          user: session.username,
          role: session.userSnapshot?.role || 'operator',
          tenantId: session.userSnapshot?.tenantId || 'default',
          csrfToken: session.csrfToken || null,
        };
      }
    }

    return null;
  }

  function requireAuth(req, res, next) {
    authenticateRequest(req)
      .then((auth) => {
        if (!auth) return res.status(401).json({ error: 'Unauthorized' });
        req.auth = auth;
        next();
      })
      .catch((e) => {
        logger('warn', 'Auth failed', { err: e.message });
        res.status(401).json({ error: 'Unauthorized' });
      });
  }

  function requireRole(role) {
    const allowed = role === 'admin' ? ['admin'] : ['admin', 'operator'];
    return (req, res, next) => {
      if (!req.auth || !allowed.includes(req.auth.role)) {
        return res.status(403).json({ error: 'Forbidden', required_role: role });
      }
      next();
    };
  }

  function requireAdmin(req, res, next) {
    return requireRole('admin')(req, res, next);
  }

  // CSRF validation middleware
  function requireCsrf(req, res, next) {
    // Apenas para métodos que modificam estado
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    // JWTs não usam cookies e não estão sujeitos a CSRF.
    if (req.auth?.type === 'jwt') return next();
    if (config.disableCsrf === true) return next();

    const csrfCookie = parseCookies(req.headers.cookie)[`${sessionManager.cookieName}_csrf`];
    const csrfHeader = req.headers['x-csrf-token'];

    if (!csrfCookie || !csrfHeader || !constantTimeEqual(csrfCookie, csrfHeader) ||
        (req.auth?.type === 'session' &&
          (!req.auth.csrfToken || !constantTimeEqual(req.auth.csrfToken, csrfHeader)))) {
      return res.status(403).json({ error: 'CSRF token inválido' });
    }
    next();
  }

  // ─── Auth routes (login/logout/me) ──────────────────────────────────────

  function createAuthRoutes(basePath = '/observe/api/auth') {
    const router = require('express').Router();

    router.post(`${basePath}/login`, async (req, res) => {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!username || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
      }

      try {
        const lock = config.loginGuard
          ? await config.loginGuard.check(username, req).catch((e) => {
              logger('warn', 'Login guard check failed open', { err: e.message });
              return { blocked: false };
            })
          : { blocked: false };
        if (lock.blocked) {
          const retryAfter = Math.max(1, Number(lock.retryAfterSeconds) || 1);
          res.set('Retry-After', String(retryAfter));
          return res.status(429).json({ error: 'Muitas tentativas de login. Tente novamente mais tarde.' });
        }

        const user = await adapter.findUserByUsername(username);
        if (!user || !user.active) {
          await adapter.consumePasswordCost?.(password);
          await config.loginGuard?.recordFailure(username, req).catch((e) => {
            logger('warn', 'Login guard failure record failed', { err: e.message });
          });
          return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const valid = await adapter.verifyPassword(user, password);
        if (!valid) {
          await config.loginGuard?.recordFailure(username, req).catch((e) => {
            logger('warn', 'Login guard failure record failed', { err: e.message });
          });
          return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        await config.loginGuard?.recordSuccess(username, req).catch((e) => {
          logger('warn', 'Login guard success record failed', { err: e.message });
        });

        const session = await sessionManager.createSession(user.username, {
          id: user.id || user.username,
          username: user.username,
          role: user.role || 'operator',
          active: user.active,
          tenantId: user.tenantId || null,
          email: user.email || null,
        }, req);

        sessionManager.setSessionCookie(req, res, session);

        res.json({
          ok: true,
          user: { name: user.username, role: user.role || 'operator' },
          expires_at: session.expiresAt,
          csrf_token: session.csrfToken,
        });
      } catch (e) {
        logger('warn', 'Login failed', { user: username, err: e.message });
        res.status(500).json({ error: 'Falha ao autenticar' });
      }
    });

    router.post(`${basePath}/logout`, requireAuth, requireCsrf, async (req, res) => {
      const token = parseCookies(req.headers.cookie)[sessionManager.cookieName];
      if (token) await sessionManager.destroySession(token);
      sessionManager.clearSessionCookie(req, res);
      res.json({ ok: true });
    });

    router.get(`${basePath}/me`, requireAuth, async (req, res) => {
      res.json({
        user: {
          name: req.auth.user,
          role: req.auth.role,
          auth_type: req.auth.type,
          tenant_id: req.auth.tenantId || null,
        },
      });
    });

    return router;
  }

  return {
    // Session
    sessionManager,
    
    // JWT M2M
    signInternalToken,
    verifyInternalToken,
    hasPrivateKey: !!PRIVATE_KEY,
    hasPublicKey: !!PUBLIC_KEY || PUBLIC_KEYRING.size > 0,
    
    // Middleware
    authenticateRequest,
    requireAuth,
    requireRole,
    requireAdmin,
    requireCsrf,
    
    // Rotas
    createAuthRoutes,
    
    // Utilidades
    parseCookies,
    sessionHash,
    
    // Init
    init: () => sessionManager.init(),
  };
}

module.exports = {
  createAuthSystem,
  SessionManager,
  jwtPayloadToAuth,
  parseScopes,
  hasScopes,
  requireScope,
  requireScopeForJwt,
  durationSeconds,
  hasValidTokenWindow,
  validateSigningClaims,
  loadPublicKeyring,
  parseCookies,
  sessionHash,
  generateCsrfToken,
  constantTimeEqual,
  isHttpsRequest,

  // ─── Standalone JWT helpers (para serviços que só precisam de M2M) ────
  // Uso: const { signInternalToken, verifyInternalToken, requireJwt } = require('@results/auth');
  createJwtHelpers(env = process.env) {
    const fs = require('fs');
    const PRIVATE_KEY = loadKey('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_FILE', env);
    const PUBLIC_KEY = loadKey('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_FILE', env);
    const PUBLIC_KEYRING = loadPublicKeyring(env);
    const issuer = env.JWT_ISSUER || 'r-observe';
    const expectedAudience = env.JWT_AUDIENCE || null;
    const requiredScopes = String(env.JWT_REQUIRED_SCOPES || '')
      .split(/[ ,]+/)
      .filter(Boolean);
    const allowedServices = String(env.JWT_ALLOWED_SERVICES || '').split(/[ ,]+/).filter(Boolean);
    const requireJti = String(env.JWT_REQUIRE_JTI || 'false').toLowerCase() === 'true';
    const maxLifetimeSeconds = durationSeconds(env.JWT_MAX_LIFETIME);
    const clockToleranceSeconds = Number(env.JWT_CLOCK_TOLERANCE_SECONDS || 5);
    const signerPolicy = signingPolicy(env, env.JWT_DEFAULT_AUDIENCE || expectedAudience);
    const keyId = env.JWT_KEY_ID || signerPolicy.service || null;

    function signInternalToken(claims = {}) {
      if (!PRIVATE_KEY) {
        throw new Error('JWT_PRIVATE_KEY ausente: este serviço não pode assinar tokens internos');
      }
      const signingIdentity = validateSigningClaims(claims, signerPolicy);
      const payload = {
        sub: claims.sub || 'r-observe',
        iat: Math.floor(Date.now() / 1000),
        service: signingIdentity.service,
        jti: claims.jti || crypto.randomUUID(),
        iss: claims.iss || issuer,
        aud: signingIdentity.audience || undefined,
        ...claims,
      };
      return jwt.sign(payload, PRIVATE_KEY, {
        algorithm: ALG,
        expiresIn: env.JWT_EXPIRY || DEFAULT_JWT_EXPIRY,
        ...(keyId ? { keyid: keyId } : {}),
      });
    }

    function verifyInternalToken(token) {
      if (!token || (!PUBLIC_KEY && !PUBLIC_KEYRING.size)) return null;
      try {
        const selected = verificationKey(token, PUBLIC_KEY, PUBLIC_KEYRING);
        if (!selected.key) return null;
        const options = { algorithms: [ALG], issuer, clockTolerance: clockToleranceSeconds };
        if (expectedAudience) options.audience = expectedAudience;
        const payload = jwt.verify(token, selected.key, options);
        const scopes = parseScopes(payload.scope);
        if (requiredScopes.some((scope) => !scopes.includes(scope) && !scopes.includes('*'))) return null;
        if (requireJti && !payload.jti) return null;
        if (allowedServices.length && !allowedServices.includes(payload.service)) return null;
        if (!hasValidTokenWindow(payload, maxLifetimeSeconds, clockToleranceSeconds)) return null;
        if (selected.kid && payload.service !== selected.kid) return null;
        return payload;
      } catch (_) {
        return null;
      }
    }

    function requireJwt(req, res, next) {
      const provided = req.headers['x-internal-token'] ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const payload = verifyInternalToken(provided);
      if (!payload) return res.status(401).json({ error: 'Unauthorized' });
      req.auth = jwtPayloadToAuth(payload);
      next();
    }

    return {
      signInternalToken,
      verifyInternalToken,
      requireJwt,
      hasPrivateKey: !!PRIVATE_KEY,
      hasPublicKey: !!PUBLIC_KEY || PUBLIC_KEYRING.size > 0,
    };
  },
};

// API direta para serviços. A criação é lazy para permitir que testes e
// entrypoints configurem as chaves no ambiente antes do primeiro uso.
let defaultJwtHelpers;
function getDefaultJwtHelpers() {
  if (!defaultJwtHelpers) defaultJwtHelpers = module.exports.createJwtHelpers(process.env);
  return defaultJwtHelpers;
}

module.exports.signInternalToken = (...args) => getDefaultJwtHelpers().signInternalToken(...args);
module.exports.verifyInternalToken = (...args) => getDefaultJwtHelpers().verifyInternalToken(...args);
module.exports.requireJwt = (...args) => getDefaultJwtHelpers().requireJwt(...args);
module.exports.getJwtCapabilities = () => ({
  hasPrivateKey: getDefaultJwtHelpers().hasPrivateKey,
  hasPublicKey: getDefaultJwtHelpers().hasPublicKey,
});
