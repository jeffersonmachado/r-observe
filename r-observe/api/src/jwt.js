'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET não configurado. Defina no .env.observe.');
  process.exit(1);
}
const JWT_EXPIRY  = process.env.JWT_EXPIRY  || '5m';

/**
 * Gera JWT para comunicacao interna entre servicos.
 * @param {object} claims - { sub, service, scope, role, ... }
 */
function verifyInternalToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

function signInternalToken(claims = {}) {
  const payload = {
    sub: claims.sub || 'r-observe-api',
    iat: Math.floor(Date.now() / 1000),
    service: claims.service || 'api',
    ...claims,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

module.exports = { signInternalToken, verifyInternalToken, JWT_SECRET };
