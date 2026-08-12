'use strict';

const fs = require('fs');
const path = require('path');

const candidates = [
  path.resolve(__dirname, '../../shared/tenant-context.js'),  // container: /app/shared
  path.resolve(__dirname, '../../../shared/tenant-context.js'), // monorepo: r-observe/shared
];
const modulePath = candidates.find((candidate) => fs.existsSync(candidate));
if (!modulePath) {
  throw new Error(`tenant-context.js não encontrado: ${candidates.join(', ')}`);
}

module.exports = require(modulePath);
