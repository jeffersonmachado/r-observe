#!/usr/bin/env node
'use strict';
// Gera JWT RS256 usando a implementação central de @results/auth.
// Usage: JWT_PRIVATE_KEY_FILE=... node scripts/observe/jwt-sign.js [sub]
const path = require('path');
const { createJwtHelpers } = require(path.resolve(__dirname, '../../packages/auth'));
const authEnv = {
  ...process.env,
  JWT_PRIVATE_KEY_FILE: process.env.JWT_PRIVATE_KEY_FILE || path.resolve(__dirname, '../../secrets/jwt_automation_private.pem'),
  JWT_KEY_ID: process.env.JWT_KEY_ID || 'automation',
  JWT_EXPIRY: process.argv[3] || process.env.JWT_EXPIRY || '15m',
};
const auth = createJwtHelpers(authEnv);
if (!auth.hasPrivateKey) {
  process.stderr.write('jwt-sign: chave privada de automação ausente; execute scripts/observe/jwt-keys.sh init\n');
  process.exit(1);
}
const sub = process.argv[2] || 'internal-script';
const token = auth.signInternalToken({
  sub,
  role: process.env.JWT_ROLE || 'operator',
  service: process.env.JWT_SERVICE || 'automation',
  scope: String(process.env.JWT_SCOPE || 'api:access').split(/[ ,]+/).filter(Boolean),
  tenant_id: process.env.JWT_TENANT_ID || 'default',
  aud: process.env.JWT_AUDIENCE || 'api',
});
process.stdout.write(token + '\n');
