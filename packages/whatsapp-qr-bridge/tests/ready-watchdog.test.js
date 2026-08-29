'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createBridge } = require('../src/index');

function fakeClient({ withHandler = false, echoAuthenticated = false } = {}) {
  const client = new EventEmitter();
  client.initialize = async () => {};
  client.destroy = async () => {};
  client.evaluateCalls = 0;
  client.evaluateTimestamps = [];
  // Simula a página: com handler, o kick chama window.onAppStateHasSyncedEvent
  // e a lib (aqui, o mock) completa o fluxo emitindo 'ready'.
  client.pupPage = {
    evaluate: async (fn) => {
      client.evaluateCalls += 1;
      client.evaluateTimestamps.push(Date.now());
      if (echoAuthenticated) {
        // A lib re-emite 'authenticated' de dentro do handler exposto —
        // no meio do evaluate do kick. Sem guarda, cada eco arma um timer
        // novo e os kicks se multiplicam.
        setImmediate(() => client.emit('authenticated'));
      }
      if (!withHandler) return null;
      const fakeWindow = {
        onAppStateHasSyncedEvent: () => {
          setImmediate(() => client.emit('ready'));
          return Promise.resolve(null);
        },
      };
      return new Function('window', `return (${fn.toString()})()`)(fakeWindow);
    },
  };
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('watchdog: chuta a re-injeção quando ready não dispara após authenticated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-wd-'));
  const client = fakeClient();
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    readyWatchdogMs: 30,
    clientFactory: () => client,
  });

  await bridge.addConnection({ id: 'conn-wd' });
  client.emit('authenticated');
  await sleep(200); // ~6 janelas de 30ms — para no teto de 3 tentativas

  assert.equal(client.evaluateCalls, 3, `esperava 3 kicks, veio ${client.evaluateCalls}`);
  const statuses = [];
  bridge.on('status', ({ status }) => statuses.push(status));
  assert.equal(bridge.getStatus('conn-wd').ready, false);

  await bridge.stop();
});

test('watchdog: não chuta quando ready dispara antes do prazo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-wd-'));
  const client = fakeClient();
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    readyWatchdogMs: 50,
    clientFactory: () => client,
  });

  await bridge.addConnection({ id: 'conn-wd-ok' });
  client.emit('authenticated');
  await sleep(10);
  client.emit('ready');
  await sleep(150);

  assert.equal(client.evaluateCalls, 0, 'não deveria ter chutado');
  assert.equal(bridge.getStatus('conn-wd-ok').ready, true);

  await bridge.stop();
});

test('watchdog: kick executa window.onAppStateHasSyncedEvent e destrava o ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-wd-'));
  const client = fakeClient({ withHandler: true });
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    readyWatchdogMs: 30,
    clientFactory: () => client,
  });

  await bridge.addConnection({ id: 'conn-wd-kick' });
  client.emit('authenticated');
  await sleep(150);

  assert.ok(client.evaluateCalls >= 1, 'kick deveria ter rodado');
  assert.equal(bridge.getStatus('conn-wd-kick').ready, true);

  await bridge.stop();
});

test('watchdog: readyWatchdogMs=0 desliga', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-wd-'));
  const client = fakeClient();
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    readyWatchdogMs: 0,
    clientFactory: () => client,
  });

  await bridge.addConnection({ id: 'conn-wd-off' });
  client.emit('authenticated');
  await sleep(120);

  assert.equal(client.evaluateCalls, 0, 'watchdog desligado não deveria chutar');

  await bridge.stop();
});

test('watchdog: eco de authenticated durante o kick não multiplica timers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-wd-'));
  const client = fakeClient({ echoAuthenticated: true });
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    readyWatchdogMs: 40,
    clientFactory: () => client,
  });

  await bridge.addConnection({ id: 'conn-wd-echo' });
  client.emit('authenticated');
  await sleep(450); // ~11 janelas de 40ms

  // Sem a guarda, cada kick ecoa authenticated e arma timers paralelos:
  // evaluateCalls explodiria (visto em prod: 3 kicks no mesmo segundo).
  assert.equal(client.evaluateCalls, 3, `esperava 3 kicks espaçados, veio ${client.evaluateCalls}`);
  for (let i = 1; i < client.evaluateTimestamps.length; i++) {
    const gap = client.evaluateTimestamps[i] - client.evaluateTimestamps[i - 1];
    assert.ok(gap >= 30, `kicks colados (${gap}ms) — timer duplicado`);
  }

  await bridge.stop();
});
