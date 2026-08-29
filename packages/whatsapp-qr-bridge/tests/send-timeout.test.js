'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBridge } = require('../src/index');

/**
 * FakeClient cujo sendMessage NUNCA resolve — simula a sessão zumbi (morta
 * remotamente sem evento, ex.: aparelho removido em "Aparelhos conectados").
 */
class HungClient extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  async initialize() {}

  sendMessage() {
    return new Promise(() => {});
  }

  async destroy() {
    this.destroyed = true;
  }
}

function makeHungBridge(bridgeOpts = {}) {
  const clients = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-hung-'));
  const bridge = createBridge({
    authDataPath: dir,
    syncIntervalMs: 0,
    clientFactory: () => {
      const c = new HungClient();
      clients.push(c);
      return c;
    },
    ...bridgeOpts,
  });
  return { bridge, clients };
}

test('sendText com sessão zumbi estoura o timeout, marca error e destrói o cliente', async () => {
  // O timer do timeout é unref'd (não pode segurar o processo em prod); no
  // teste o loop esvaziaria antes de ele disparar — keep-alive simula o
  // processo real, que sempre tem outros handles vivos.
  const keepAlive = setInterval(() => {}, 25);
  const { bridge, clients } = makeHungBridge({ sendTimeoutMs: 50 });
  try {
    const errors = [];
    bridge.on('error', (p) => errors.push(p));

    await bridge.addConnection({ id: 'conn-hung' });
    clients[0].emit('ready');
    assert.equal(bridge.getStatus('conn-hung').ready, true);

    const out = await bridge.sendText('conn-hung', '5511999990000', 'olá');
    assert.equal(out.ok, false);
    assert.equal(out.error, 'qr_send_failed');
    assert.match(out.message, /send_timeout_50ms/);

    assert.equal(bridge.getStatus('conn-hung').status, 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /send_timeout_50ms/);
    // destroy é async no handler do timeout — aguarda um tick.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(clients[0].destroyed, true);
  } finally {
    clearInterval(keepAlive);
    await bridge.stop();
  }
});

test('sendMedia zumbi também estoura o timeout', async () => {
  const keepAlive = setInterval(() => {}, 25);
  const { bridge, clients } = makeHungBridge({ sendTimeoutMs: 50 });
  try {
    bridge.on('error', () => {}); // emitter lança em 'error' sem listener
    await bridge.addConnection({ id: 'conn-hung-media' });
    clients[0].emit('ready');

    const out = await bridge.sendMedia('conn-hung-media', '5511999990000', {
      data: Buffer.from('x').toString('base64'), mimeType: 'image/png',
    });
    assert.equal(out.ok, false);
    assert.match(out.message, /send_timeout_50ms/);
  } finally {
    clearInterval(keepAlive);
    await bridge.stop();
  }
});

test('sendTimeoutMs=0 desliga o timeout (envio pendente permanece pendente)', async () => {
  const { bridge, clients } = makeHungBridge({ sendTimeoutMs: 0 });
  await bridge.addConnection({ id: 'conn-no-timeout' });
  clients[0].emit('ready');

  let settled = false;
  bridge.sendText('conn-no-timeout', '5511999990000', 'olá').then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(settled, false);
  assert.equal(bridge.getStatus('conn-no-timeout').status, 'ready');
  assert.equal(clients[0].destroyed, false);

  await bridge.stop();
});

test('envio que resolve antes do timeout não é afetado', async () => {
  const clients = [];
  const bridge = createBridge({
    authDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'waqr-fast-')),
    syncIntervalMs: 0,
    sendTimeoutMs: 5000,
    clientFactory: () => {
      const c = new EventEmitter();
      c.initialize = async () => {};
      c.sendMessage = async () => ({ id: { _serialized: 'fast-1' } });
      c.destroy = async () => {};
      clients.push(c);
      return c;
    },
  });
  await bridge.addConnection({ id: 'conn-fast' });
  clients[0].emit('ready');
  const res = await bridge.sendText('conn-fast', '5511999990000', 'olá');
  assert.equal(res.ok, true);
  assert.equal(res.externalMessageId, 'fast-1');
  await bridge.stop();
});
