'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET não configurado. Defina no .env.observe.');
  process.exit(1);
}
const JWT_SECRET_RAW = JWT_SECRET;

/**
 * Verifica JWT interno. Retorna payload decodificado ou null.
 */
function verifyInternalToken(token) {
  if (!token) return null;
  // Aceita token fixo raw (compatibilidade)
  if (JWT_SECRET_RAW && token === JWT_SECRET_RAW) {
    return { sub: 'internal', role: 'admin', type: 'token' };
  }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

/**
 * Middleware: verifica JWT no header x-internal-token.
 * Se JWT_SECRET nao definido (dev mode), permite sem token.
 */
function requireJwt(req, res, next) {
  if (!JWT_SECRET) {
    req.auth = { type: 'dev', user: 'dev', role: 'admin' };
    return next();
  }
  const provided = req.headers['x-internal-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = verifyInternalToken(provided);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = {
    type: 'jwt',
    user: payload.sub || 'internal',
    role: payload.role || 'admin',
    service: payload.service || null,
    scope: payload.scope || null,
  };
  next();
}

module.exports = { verifyInternalToken, requireJwt, JWT_SECRET };
