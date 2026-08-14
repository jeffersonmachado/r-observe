'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createWhatsAppQrService } = require('../src/services/whatsapp-qr');

const log = () => {};

function makeDb({ row = null, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (fail) throw new Error('db down');
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    },
  };
}

const baseRow = {
  enabled: true,
  desired_state: 'connected',
  status: 'pairing',
  qr_data_url: 'data:image/png;base64,xxx',
  qr_expires_at: new Date(Date.now() + 60000).toISOString(),
  last_error: null,
  updated_at: new Date().toISOString(),
};

describe('WhatsApp QR service (API)', () => {
  it('retorna desconectado quando não há linha', async () => {
    const svc = createWhatsAppQrService({ db: makeDb(), log });
    const st = await svc.getStatus();
    assert.deepEqual(st, { enabled: false, status: 'disconnected', qrDataUrl: null, qrExpiresAt: null, lastError: null });
  });

  it('expõe QR válido e esconde QR expirado', async () => {
    const svc = createWhatsAppQrService({ db: makeDb({ row: baseRow }), log });
    const st = await svc.getStatus();
    assert.equal(st.enabled, true);
    assert.equal(st.status, 'pairing');
    assert.equal(st.qrDataUrl, baseRow.qr_data_url);
    assert.equal(st.qrExpiresAt, baseRow.qr_expires_at);

    const expired = createWhatsAppQrService({
      db: makeDb({ row: { ...baseRow, qr_expires_at: new Date(Date.now() - 60000).toISOString() } }),
      log,
    });
    const st2 = await expired.getStatus();
    assert.equal(st2.qrDataUrl, null);
    assert.equal(st2.qrExpiresAt, null);
  });

  it('expõe lastError quando presente', async () => {
    const svc = createWhatsAppQrService({ db: makeDb({ row: { ...baseRow, status: 'error', last_error: 'boom' } }), log });
    const st = await svc.getStatus();
    assert.equal(st.status, 'error');
    assert.equal(st.lastError, 'boom');
  });

  it('connect marca enabled=true e desired_state=connected (upsert na linha default)', async () => {
    const db = makeDb({ row: baseRow });
    const svc = createWhatsAppQrService({ db, log });
    await svc.connect();
    assert.match(db.calls[0].sql, /INSERT INTO observe_whatsapp_qr_connections/);
    assert.match(db.calls[0].sql, /ON CONFLICT \(id\) DO UPDATE SET enabled = TRUE, desired_state = 'connected'/);
    assert.deepEqual(db.calls[0].params, ['default']);
  });

  it('disconnect derruba a sessão e preserva enabled por padrão', async () => {
    const db = makeDb({ row: { ...baseRow, status: 'disconnected' } });
    const svc = createWhatsAppQrService({ db, log });
    await svc.disconnect();
    assert.match(db.calls[0].sql, /desired_state = 'disconnected'/);
    assert.match(db.calls[0].sql, /ELSE observe_whatsapp_qr_connections\.enabled END/);
    assert.deepEqual(db.calls[0].params, ['default', false]);
  });

  it('disconnect com enabled:false também desabilita o canal', async () => {
    const db = makeDb({ row: { ...baseRow, enabled: false, status: 'disconnected' } });
    const svc = createWhatsAppQrService({ db, log });
    await svc.disconnect({ enabled: false });
    assert.deepEqual(db.calls[0].params, ['default', true]);
  });

  it('propaga erro do banco', async () => {
    const svc = createWhatsAppQrService({ db: makeDb({ fail: true }), log });
    await assert.rejects(() => svc.getStatus(), /db down/);
  });
});

describe('WhatsApp QR endpoints (contrato no index.js)', () => {
  const apiCode = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');

  it('rotas QR registradas com auth de admin', () => {
    assert.match(apiCode, /app\.get\(`\$\{BASE\}\/system\/whatsapp\/qr\/status`, requireAuth, requireAdmin,/);
    assert.match(apiCode, /app\.post\(`\$\{BASE\}\/system\/whatsapp\/qr\/connect`, requireAuth, requireAdmin, requireAdminWrite,/);
    assert.match(apiCode, /app\.post\(`\$\{BASE\}\/system\/whatsapp\/qr\/disconnect`, requireAuth, requireAdmin, requireAdminWrite,/);
  });
});
