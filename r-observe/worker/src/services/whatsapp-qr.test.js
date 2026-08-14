'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const { createWhatsAppQrService } = require('./whatsapp-qr');

function makeFakeBridge() {
  const bridge = new EventEmitter();
  let active = false;
  bridge.getStatus = () => (active ? { ok: true, ready: false } : { ok: false, error: 'not_found' });
  bridge.addConnection = async () => { active = true; return { ok: true }; };
  bridge.requestQr = async () => ({ ok: true });
  bridge.disconnect = async () => { active = false; return { ok: true }; };
  bridge.sendText = async () => ({ ok: true });
  bridge.stop = async () => {};
  return bridge;
}

function makeDb() {
  const connEvents = [];
  return {
    connEvents,
    async query(sql, params) {
      if (/SELECT enabled, desired_state/.test(sql)) {
        return { rowCount: 1, rows: [{ enabled: true, desired_state: 'connected' }] };
      }
      if (/INSERT INTO observe_whatsapp_connection_events/.test(sql)) {
        connEvents.push({ channel: params[0], event: params[2], detail: params[3] });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

async function makeService() {
  const db = makeDb();
  const bridge = makeFakeBridge();
  const svc = createWhatsAppQrService({
    db,
    log: () => {},
    env: { WHATSAPP_QR_ENABLED: 'true' },
    createBridgeImpl: () => bridge,
  });
  await svc.pollOnce(); // aplica desired_state=connected e sobe o bridge fake
  await flush();
  db.connEvents.length = 0; // ignora command_applied do setup
  return { db, bridge };
}

const eventsOf = (db, event) => db.connEvents.filter((e) => e.event === event);

describe('WhatsApp QR — dedupe do log de conexões', () => {
  it('dois status_changed=pairing seguidos gravam apenas 1', async () => {
    const { db, bridge } = await makeService();
    bridge.emit('status', { status: 'pairing' });
    bridge.emit('status', { status: 'pairing' });
    bridge.emit('status', { status: 'pairing' });
    await flush();
    assert.equal(eventsOf(db, 'status_changed').length, 1);
    assert.match(eventsOf(db, 'status_changed')[0].detail, /status=pairing/);
  });

  it('status_changed com status diferente grava (pairing → connected)', async () => {
    const { db, bridge } = await makeService();
    bridge.emit('status', { status: 'pairing' });
    bridge.emit('status', { status: 'connected' });
    await flush();
    assert.equal(eventsOf(db, 'status_changed').length, 2);
    assert.match(eventsOf(db, 'status_changed')[1].detail, /status=connected/);
  });

  it('qr_generated repetido em menos de 5 min grava apenas 1', async () => {
    const { db, bridge } = await makeService();
    // Ordem real do bridge: a cada renovação do WA Web (~20-30s) ele emite
    // setStatus('pairing') seguido do evento 'qr'.
    bridge.emit('status', { status: 'pairing' });
    bridge.emit('qr', { qrText: 'a', qrDataUrl: null, expiresAt: null });
    bridge.emit('status', { status: 'pairing' });
    bridge.emit('qr', { qrText: 'b', qrDataUrl: null, expiresAt: null });
    bridge.emit('status', { status: 'pairing' });
    bridge.emit('qr', { qrText: 'c', qrDataUrl: null, expiresAt: null });
    await flush();
    assert.equal(eventsOf(db, 'status_changed').length, 1);
    assert.equal(eventsOf(db, 'qr_generated').length, 1);
  });

  it('qr_generated grava de novo quando houve mudança real de status entre eles', async () => {
    const { db, bridge } = await makeService();
    bridge.emit('qr', { qrText: 'a', qrDataUrl: null, expiresAt: null });
    bridge.emit('status', { status: 'connected' });
    bridge.emit('qr', { qrText: 'b', qrDataUrl: null, expiresAt: null });
    await flush();
    assert.equal(eventsOf(db, 'qr_generated').length, 2);
  });

  it('qr_generated grava de novo após a janela de 5 minutos', async () => {
    const { db, bridge } = await makeService();
    const realNow = Date.now;
    try {
      let now = realNow();
      Date.now = () => now;
      bridge.emit('qr', { qrText: 'a', qrDataUrl: null, expiresAt: null });
      now += 6 * 60 * 1000; // 6 min depois, sem mudança de status
      bridge.emit('qr', { qrText: 'b', qrDataUrl: null, expiresAt: null });
      await flush();
      assert.equal(eventsOf(db, 'qr_generated').length, 2);
    } finally {
      Date.now = realNow;
    }
  });

  it('ready e error continuam sempre registrados', async () => {
    const { db, bridge } = await makeService();
    bridge.emit('ready', {});
    bridge.emit('ready', {});
    bridge.emit('error', { error: 'boom' });
    await flush();
    assert.equal(eventsOf(db, 'ready').length, 2);
    assert.equal(eventsOf(db, 'error').length, 1);
  });

  it('dedupe não impede o persist do estado na tabela de conexão', async () => {
    const db = makeDb();
    const updates = [];
    const origQuery = db.query.bind(db);
    db.query = async (sql, params) => {
      if (/UPDATE observe_whatsapp_qr_connections/.test(sql)) updates.push(sql);
      return origQuery(sql, params);
    };
    const bridge = makeFakeBridge();
    const svc = createWhatsAppQrService({
      db, log: () => {}, env: { WHATSAPP_QR_ENABLED: 'true' }, createBridgeImpl: () => bridge,
    });
    await svc.pollOnce();
    bridge.emit('qr', { qrText: 'a', qrDataUrl: null, expiresAt: null });
    bridge.emit('qr', { qrText: 'b', qrDataUrl: null, expiresAt: null });
    await flush();
    // os dois QRs atualizam o estado na tabela, mesmo com o log deduplicado
    assert.ok(updates.length >= 2);
  });
});
