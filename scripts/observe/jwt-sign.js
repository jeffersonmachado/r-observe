#!/usr/bin/env node
'use strict';
// Gera um JWT assinado com JWT_SECRET para uso em scripts de automação.
// Usage: JWT_SECRET=xxx node scripts/observe/jwt-sign.js [sub] [expiry]
const path = require('path');
const jwt = require(path.resolve(__dirname, '../../r-observe/api/node_modules/jsonwebtoken'));
const secret = process.env.JWT_SECRET || '';
if (!secret) {
  process.stderr.write('jwt-sign: JWT_SECRET não definido\n');
  process.exit(1);
}
const sub = process.argv[2] || 'internal-script';
const expiry = process.argv[3] || '15m';
const token = jwt.sign({ sub, role: 'admin', service: sub }, secret, { expiresIn: expiry });
process.stdout.write(token + '\n');
