'use strict';

// Autenticação interna entre serviços via JWT assimétrico (RS256).
// A chave privada assina; a pública verifica. Não há segredo compartilhado.
//   - Serviços que assinam (api, worker, agent, discovery) recebem a chave privada.
//   - Serviços que verificam (api, ai, discovery) recebem a chave pública.
const fs = require('fs');
const jwt = require('jsonwebtoken');

const ALG = 'RS256';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '5m';

function loadKey(inlineVar, fileVar) {
  const inline = process.env[inlineVar];
  if (inline && inline.includes('BEGIN')) return inline.replace(/\\n/g, '\n');
  const file = process.env[fileVar];
  if (file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { /* ausente */ }
  }
  return null;
}

const PRIVATE_KEY = loadKey('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_FILE');
const PUBLIC_KEY = loadKey('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_FILE');

function signInternalToken(claims = {}) {
  if (!PRIVATE_KEY) {
    throw new Error('JWT_PRIVATE_KEY ausente: este serviço não pode assinar tokens internos');
  }
  const payload = {
    sub: claims.sub || 'r-observe',
    iat: Math.floor(Date.now() / 1000),
    service: claims.service || 'unknown',
    ...claims,
  };
  return jwt.sign(payload, PRIVATE_KEY, { algorithm: ALG, expiresIn: JWT_EXPIRY });
}

function verifyInternalToken(token) {
  if (!token || !PUBLIC_KEY) return null;
  try {
    return jwt.verify(token, PUBLIC_KEY, { algorithms: [ALG] });
  } catch (_) {
    return null;
  }
}

// Middleware: exige JWT interno válido no header x-internal-token (ou Bearer).
function requireJwt(req, res, next) {
  const provided = req.headers['x-internal-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
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

module.exports = {
  signInternalToken,
  verifyInternalToken,
  requireJwt,
  hasPrivateKey: !!PRIVATE_KEY,
  hasPublicKey: !!PUBLIC_KEY,
};
