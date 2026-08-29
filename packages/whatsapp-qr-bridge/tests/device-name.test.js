'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridge } = require('../src/index');

function fakeClientFactory(received) {
  return (opts) => {
    received.push(opts);
    return { on() {}, async initialize() {}, async destroy() {} };
  };
}

test('createBridge repassa deviceName à clientFactory', async () => {
  const received = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-dn-'));
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    deviceName: 'R-Observe',
    clientFactory: fakeClientFactory(received),
  });

  await bridge.addConnection({ id: 'conn-dn' });
  assert.equal(received.length, 1);
  assert.equal(received[0].deviceName, 'R-Observe');

  await bridge.stop();
});

test('createBridge sem deviceName (ou em branco) passa undefined', async () => {
  for (const deviceName of [undefined, '   ']) {
    const received = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-dn-'));
    const bridge = createBridge({
      authDataPath: dir,
      syncIntervalMs: 0,
      deviceName,
      clientFactory: fakeClientFactory(received),
    });

    await bridge.addConnection({ id: 'conn-dn-empty' });
    assert.equal(received.length, 1);
    assert.equal(received[0].deviceName, undefined);

    await bridge.stop();
  }
});
