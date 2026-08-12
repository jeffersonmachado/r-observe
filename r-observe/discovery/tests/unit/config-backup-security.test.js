'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('backups de configuração usam diretório 0700 e arquivo 0600', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/engine/config-backup.js'), 'utf8');
  assert.match(source, /recursive:\s*true,\s*mode:\s*0o700/);
  assert.match(source, /chmodSync\(path\.dirname\(filePath\),\s*0o700\)/);
  assert.match(source, /writeFileSync\(filePath,\s*config,\s*\{\s*mode:\s*0o600\s*\}\)/);
});
