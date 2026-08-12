'use strict';

const { createAuthSystem, parseCookies, sessionHash } = require('@results/auth');
const { ObserveAdapter } = require('../auth/observe-adapter');
const { runWithTenant } = require('../shared/tenant-context');

/**
 * Middleware de autenticação e RBAC para o R-Observe API.
 * Extraído de index.js para reduzir o tamanho do arquivo principal.
 */

function createAuthMiddleware(db, sessionCookieName, log, options = {}) {
  const adapter = new ObserveAdapter(db, {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
  });
  const system = createAuthSystem({
    adapter,
    config: {
      sessionCookieName,
      sessionTTLHours: parseInt(process.env.OBSERVE_SESSION_TTL_HOURS || '12', 10),
      disableCsrf: process.env.NODE_ENV === 'development',
      loginGuard: options.loginGuard,
      env: process.env,
    },
    log,
  });

  async function requireAuth(req, res, next) {
    try {
      const auth = await system.authenticateRequest(req);
      if (!auth) return res.status(401).json({ error: 'Unauthorized' });
      req.auth = auth;
      runWithTenant(auth.tenantId || 'default', next);
    } catch (e) {
      log('warn', 'Auth failed', { err: e.message });
      res.status(401).json({ error: 'Unauthorized' });
    }
  }

  return {
    system,
    init: system.init,
    createAuthRoutes: system.createAuthRoutes,
    requireAuth,
    requireRole: system.requireRole,
    requireAdmin: system.requireAdmin,
    requireCsrf: system.requireCsrf,
    parseCookies,
    sessionHash,
    authenticateRequest: system.authenticateRequest,
  };
}

module.exports = { createAuthMiddleware };
