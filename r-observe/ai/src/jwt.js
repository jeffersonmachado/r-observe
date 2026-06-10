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

function requireJwt(req, res, next) {
  if (!JWT_SECRET) return next();
  const provided = req.headers['x-internal-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = verifyInternalToken(provided);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = { type: 'jwt', user: payload.sub || 'internal', role: payload.role || 'admin' };
  next();
}

module.exports = { verifyInternalToken, requireJwt, JWT_SECRET };
