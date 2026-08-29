'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createBridge,
  resolveUserAgent,
} = require('../src/index');

function fakeChrome(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-fakechrome-'));
  const bin = path.join(dir, 'chrome');
  fs.writeFileSync(bin, `#!/bin/sh\necho "Google Chrome ${version}"\n`, { mode: 0o755 });
  return bin;
}

test('resolveUserAgent: "default" preserva o spoof nativo da lib (undefined)', () => {
  assert.equal(resolveUserAgent({ userAgent: 'default', executablePath: '/bin/false' }), undefined);
  assert.equal(resolveUserAgent({ userAgent: ' DEFAULT ', executablePath: '/bin/false' }), undefined);
});

test('resolveUserAgent: false desliga o spoof da lib', () => {
  assert.equal(resolveUserAgent({ userAgent: false }), false);
});

test('resolveUserAgent: string custom é usada como está', () => {
  const ua = 'Mozilla/5.0 (Custom) Chrome/1.2.3.4';
  assert.equal(resolveUserAgent({ userAgent: ua, executablePath: '/bin/false' }), ua);
});

test('resolveUserAgent: auto detecta a versão real do binário (sem o fingerprint Chrome 101)', () => {
  const bin = fakeChrome('999.1.2.3');
  const ua = resolveUserAgent({ executablePath: bin });
  assert.ok(ua.includes('Chrome/999.1.2.3'), `UA sem a versão detectada: ${ua}`);
  assert.ok(!ua.includes('101.0.4951.67'), `UA com fingerprint congelado: ${ua}`);
  assert.ok(ua.startsWith('Mozilla/5.0 ('), `UA malformado: ${ua}`);
});

test('resolveUserAgent: "auto" explícito equivale ao default', () => {
  const bin = fakeChrome('999.1.2.3');
  const auto = resolveUserAgent({ userAgent: 'auto', executablePath: bin });
  const implicit = resolveUserAgent({ executablePath: bin });
  assert.equal(auto, implicit);
});

test('createBridge repassa o userAgent resolvido à clientFactory', async () => {
  const received = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-ua-'));
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    userAgent: 'Mozilla/5.0 (Test) Chrome/7.7.7.7',
    clientFactory: (opts) => {
      received.push(opts);
      return {
        on() {},
        async initialize() {},
        async destroy() {},
      };
    },
  });

  await bridge.addConnection({ id: 'conn-ua' });
  assert.equal(received.length, 1);
  assert.equal(received[0].userAgent, 'Mozilla/5.0 (Test) Chrome/7.7.7.7');

  await bridge.stop();
});
