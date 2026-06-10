'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET não configurado. Defina no .env.observe.');
  process.exit(1);
}

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
    sub: claims.sub || 'r-observe-worker',
    iat: Math.floor(Date.now() / 1000),
    service: claims.service || 'worker',
    ...claims,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '5m' });
}

module.exports = { verifyInternalToken, signInternalToken, JWT_SECRET };
