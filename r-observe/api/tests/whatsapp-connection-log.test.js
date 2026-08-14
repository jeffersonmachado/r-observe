'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createWhatsAppConnectionLog, KNOWN_EVENTS } = require('../src/shared/whatsapp-connection-log');

function makeDb({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (fail) throw new Error('db down');
      return { rowCount: 1, rows: [{ id: 1 }] };
    },
  };
}

const log = () => {};

describe('WhatsApp connection events log', () => {
  it('registra evento com defaults (connection_id default, canal normalizado)', async () => {
    const db = makeDb();
    const audit = createWhatsAppConnectionLog({ db, log });
    await audit.record({ channel: 'qr', event: 'ready' });
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0].sql, /INSERT INTO observe_whatsapp_connection_events/);
    assert.deepEqual(db.calls[0].params, ['qr', 'default', 'ready', null]);
    // canal fora do esperado cai no default seguro
    await audit.record({ channel: 'pigeon', event: 'error', detail: 'x' });
    assert.equal(db.calls[1].params[0], 'cloud');
  });

  it('trunca detail, event e connection_id longos', async () => {
    const db = makeDb();
    const audit = createWhatsAppConnectionLog({ db, log });
    await audit.record({
      channel: 'cloud', connectionId: 'c'.repeat(150),
      event: 'e'.repeat(80), detail: 'd'.repeat(1500),
    });
    assert.equal(db.calls[0].params[1].length, 100);
    assert.equal(db.calls[0].params[2].length, 60);
    assert.equal(db.calls[0].params[3].length, 1000);
  });

  it('nunca lança exceção quando o banco falha', async () => {
    const audit = createWhatsAppConnectionLog({ db: makeDb({ fail: true }), log });
    await audit.record({ channel: 'qr', event: 'service_started', detail: 'x' });
  });

  it('lista eventos com limite entre 1 e 200', async () => {
    const db = makeDb();
    const audit = createWhatsAppConnectionLog({ db, log });
    await audit.listRecent({ limit: 20 });
    assert.equal(db.calls[0].params.at(-2), 20);
    await audit.listRecent({ limit: 9999 });
    assert.equal(db.calls[1].params.at(-2), 200);
    await audit.listRecent({ limit: 'abc' });
    assert.equal(db.calls[2].params.at(-2), 50);
    assert.match(db.calls[0].sql, /COUNT\(\*\) OVER\(\) AS total/);
  });

  it('aplica filtros de canal e evento whitelistados', async () => {
    const db = makeDb();
    const audit = createWhatsAppConnectionLog({ db, log });
    await audit.listRecent({ channel: 'qr', event: 'qr_generated', limit: 10, offset: 40 });
    const { sql, params } = db.calls[0];
    assert.match(sql, /channel = \$1/);
    assert.match(sql, /event = \$2/);
    assert.deepEqual(params, ['qr', 'qr_generated', 10, 40]);
  });

  it('ignora valores de filtro inválidos', async () => {
    const db = makeDb();
    const audit = createWhatsAppConnectionLog({ db, log });
    await audit.listRecent({ channel: 'sideways', event: 'hack' });
    assert.doesNotMatch(db.calls[0].sql, /WHERE/);
  });

  it('todos os eventos instrumentados estão na whitelist', () => {
    for (const ev of ['service_started', 'command_applied', 'connect_requested', 'disconnect_requested',
      'qr_generated', 'status_changed', 'ready', 'error', 'lock_cleared',
      'send_qr_ok', 'send_qr_fail', 'send_cloud_ok', 'send_cloud_fail']) {
      assert.ok(KNOWN_EVENTS.includes(ev), `evento ausente na whitelist: ${ev}`);
    }
  });
});

describe('WhatsApp connection log — endpoint (contrato no index.js)', () => {
  const apiCode = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');

  it('rota GET connections/log registrada com auth de admin', () => {
    assert.match(apiCode, /app\.get\(`\$\{BASE\}\/system\/whatsapp\/connections\/log`, requireAuth, requireAdmin,/);
  });

  it('endpoints connect/disconnect registram eventos de auditoria', () => {
    assert.match(apiCode, /event: 'connect_requested'/);
    assert.match(apiCode, /event: 'disconnect_requested'/);
  });

  it('helper do worker é cópia idêntica ao da API', () => {
    const workerCopy = fs.readFileSync(path.resolve(__dirname, '../../worker/src/shared/whatsapp-connection-log.js'), 'utf8');
    const apiCopy = fs.readFileSync(path.resolve(__dirname, '../src/shared/whatsapp-connection-log.js'), 'utf8');
    assert.equal(workerCopy, apiCopy);
  });
});
