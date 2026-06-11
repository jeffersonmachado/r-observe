'use strict';

const crypto = require('crypto');
const { verifyInternalToken } = require('../jwt');

/**
 * Middleware de autenticação e RBAC para o R-Observe API.
 * Extraído de index.js para reduzir o tamanho do arquivo principal.
 */

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

function setSessionCookie(req, res, sessionCookieName, token, expiresAt) {
  const secure = isHttpsRequest(req);
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });
}

function clearSessionCookie(req, res, sessionCookieName) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/',
  });
}

async function getContactRole(db, username) {
  const groupById = await db.query(`
    SELECT 1
    FROM icingaweb_group_membership gm
    JOIN icingaweb_group g ON g.id = gm.group_id
    WHERE lower(g.name) = lower('Administrators')
      AND lower(gm.username) = lower($1::text)
    LIMIT 1
  `, [username]).catch(() => ({ rowCount: 0 }));
  if (groupById.rowCount) return 'admin';

  const groupByName = await db.query(`
    SELECT 1
    FROM icingaweb_group_membership gm
    WHERE lower(gm.group_name) = lower('Administrators')
      AND lower(gm.username) = lower($1::text)
    LIMIT 1
  `, [username]).catch(() => ({ rowCount: 0 }));
  return groupByName.rowCount ? 'admin' : 'operator';
}

async function authenticateSession(req, db, sessionCookieName) {
  const token = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!token) return null;

  const r = await db.query(`
    SELECT username, role, expires_at
    FROM observe_sessions
    WHERE token_hash = $1 AND expires_at > NOW()
    LIMIT 1
  `, [sessionHash(token)]);
  if (!r.rowCount) return null;

  const session = r.rows[0];
  await db.query(
    `UPDATE observe_sessions SET last_seen_at = NOW() WHERE token_hash = $1`,
    [sessionHash(token)]
  ).catch(() => {});
  return {
    type: 'session',
    user: session.username,
    role: session.role || await getContactRole(db, session.username),
  };
}

async function authenticateRequest(req, db, sessionCookieName) {
  const provided = req.headers['x-internal-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  // M2M: JWT interno assinado com a chave privada (RS256), verificado pela pública.
  if (provided) {
    const jwtPayload = verifyInternalToken(provided);
    if (jwtPayload) {
      return { type: 'jwt', user: jwtPayload.sub || 'internal', role: jwtPayload.role || 'admin' };
    }
    // Token apresentado porém inválido: falha-fechado, não cai para sessão.
    return null;
  }
  // Usuário no navegador: sessão por cookie.
  return authenticateSession(req, db, sessionCookieName);
}

function createAuthMiddleware(db, sessionCookieName, log) {
  async function requireAuth(req, res, next) {
    try {
      const auth = await authenticateRequest(req, db, sessionCookieName);
      if (!auth) return res.status(401).json({ error: 'Unauthorized' });
      req.auth = auth;
      next();
    } catch (e) {
      log('warn', 'Auth failed', { err: e.message });
      res.status(401).json({ error: 'Unauthorized' });
    }
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

  const requireAdmin = requireRole('admin');

  return {
    requireAuth,
    requireRole,
    requireAdmin,
    parseCookies,
    sessionHash,
    setSessionCookie,
    clearSessionCookie,
    getContactRole,
    authenticateRequest,
  };
}

module.exports = { createAuthMiddleware };
