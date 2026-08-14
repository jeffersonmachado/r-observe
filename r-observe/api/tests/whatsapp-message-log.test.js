'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWhatsAppMessageLog } = require('../src/shared/whatsapp-message-log');

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

describe('WhatsApp message audit log', () => {
  it('registra mensagem com todos os campos', async () => {
    const db = makeDb();
    const audit = createWhatsAppMessageLog({ db, log });
    await audit.record({
      direction: 'out', kind: 'bot_reply', phone: '5511999999999',
      body: 'resposta', status: 'sent', metaMessageId: 'wamid.1', incidentId: null,
    });
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0].sql, /INSERT INTO observe_whatsapp_messages/);
    assert.deepEqual(db.calls[0].params, ['out', 'bot_reply', '5511999999999', 'resposta', 'sent', null, 'wamid.1', null, 'cloud']);
  });

  it('canal padrão é cloud e aceita channel=qr', async () => {
    const db = makeDb();
    const audit = createWhatsAppMessageLog({ db, log });
    await audit.record({ direction: 'in', kind: 'inbound', phone: '5511@c.us', body: 'oi', status: 'received' });
    assert.equal(db.calls[0].params[8], 'cloud');
    await audit.record({ direction: 'in', kind: 'inbound', channel: 'qr', phone: '5511@c.us', body: 'oi', status: 'received' });
    assert.equal(db.calls[1].params[8], 'qr');
    // valores fora do esperado caem no default seguro
    await audit.record({ direction: 'out', kind: 'test_send', channel: 'pigeon', phone: '1', body: 'x', status: 'sent' });
    assert.equal(db.calls[2].params[8], 'cloud');
  });

  it('trunca corpo e erro longos', async () => {
    const db = makeDb();
    const audit = createWhatsAppMessageLog({ db, log });
    await audit.record({
      direction: 'in', kind: 'webhook_in', phone: '1', body: 'x'.repeat(5000),
      status: 'failed', error: 'e'.repeat(600),
    });
    assert.equal(db.calls[0].params[3].length, 4096);
    assert.equal(db.calls[0].params[5].length, 500);
  });

  it('nunca lança exceção quando o banco falha', async () => {
    const audit = createWhatsAppMessageLog({ db: makeDb({ fail: true }), log });
    await audit.record({ direction: 'in', kind: 'webhook_in', phone: '1', body: 'oi', status: 'received' });
  });

  it('lista mensagens com limite entre 1 e 200', async () => {
    const db = makeDb();
    const audit = createWhatsAppMessageLog({ db, log });
    await audit.listRecent({ limit: 20 });
    assert.equal(db.calls[0].params.at(-2), 20);
    await audit.listRecent({ limit: 9999 });
    assert.equal(db.calls[1].params.at(-2), 200);
    await audit.listRecent({ limit: 'abc' });
    assert.equal(db.calls[2].params.at(-2), 50);
  });

  it('aplica filtros de direção, tipo, status e busca', async () => {
    const db = makeDb();
    const audit = createWhatsAppMessageLog({ db, log });
    await audit.listRecent({ direction: 'out', kind: 'bot_reply', status: 'failed', q: '5511', limit: 10, offset: 40 });
    const { sql, params } = db.calls[0];
    assert.match(sql, /direction = \$1/);
    assert.match(sql, /kind = \$2/);
    assert.match(sql, /status = \$3/);
    assert.match(sql, /phone ILIKE \$4 OR body ILIKE \$4/);
    assert.deepEqual(params, ['out', 'bot_reply', 'failed', '%5511%', 10, 40]);
  });

  it('ignora valores de filtro inválidos', async () => {
    const db = makeDb();
    const audit = createWhatsAppMessageLog({ db, log });
    await audit.listRecent({ direction: 'sideways', kind: 'hack', status: 'weird' });
    assert.doesNotMatch(db.calls[0].sql, /WHERE/);
  });
});
