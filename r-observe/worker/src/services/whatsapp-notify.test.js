'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createWhatsAppNotifier } = require('./whatsapp-notify');
const { createWhatsAppQrService } = require('./whatsapp-qr');

const log = () => {};

const CFG_CLOUD = {
  enabled: true, access_token: 'tok', phone_number_id: '123',
  recipient: '5511999999999', severity_filter: 'all',
};

function makeDb({ cfg = CFG_CLOUD } = {}) {
  const inserts = [];
  const connEvents = [];
  return {
    inserts,
    connEvents,
    async query(sql, params) {
      if (sql.includes('FROM observe_whatsapp_settings')) {
        return { rowCount: cfg ? 1 : 0, rows: cfg ? [cfg] : [] };
      }
      if (sql.includes('INSERT INTO observe_whatsapp_messages')) {
        inserts.push(params);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO observe_whatsapp_connection_events')) {
        connEvents.push(params);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

const incident = { id: 'inc-1', severity: 'critical', title: 'Host down', cause: null };

describe('WhatsApp notifier — fallback de canal', () => {
  it('usa Cloud API quando configurada (fetch chamado, canal cloud)', async () => {
    const db = makeDb();
    const qr = { qrReady: () => true, sendText: async () => { throw new Error('não deveria usar QR'); } };
    const notifier = createWhatsAppNotifier({ db, log, qr });

    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
    };
    try {
      await notifier.notifyIncident(incident);
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /graph\.facebook\.com/);
    assert.equal(db.inserts.length, 1);
    assert.equal(db.inserts[0][8], 'cloud');
    assert.equal(db.inserts[0][4], 'sent');
    // evento de conexão: envio Cloud ok com status HTTP no detail
    assert.equal(db.connEvents.length, 1);
    assert.deepEqual([db.connEvents[0][0], db.connEvents[0][2]], ['cloud', 'send_cloud_ok']);
    assert.match(db.connEvents[0][3], /to=5511999999999/);
    assert.match(db.connEvents[0][3], /http=200/);
  });

  it('cai para o canal QR quando a Cloud não está configurada e a sessão está pronta', async () => {
    const db = makeDb({ cfg: { ...CFG_CLOUD, access_token: null, phone_number_id: null } });
    const sent = [];
    const qr = { qrReady: () => true, sendText: async (to, text) => { sent.push({ to, text }); return { ok: true, externalMessageId: 'qr-1' }; } };
    const notifier = createWhatsAppNotifier({ db, log, qr });

    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('não deveria chamar a Meta'); };
    try {
      await notifier.notifyIncident(incident);
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '5511999999999');
    assert.match(sent[0].text, /R-Observe/);
    assert.equal(db.inserts.length, 1);
    assert.equal(db.inserts[0][8], 'qr');
    assert.equal(db.inserts[0][4], 'sent');
    assert.equal(db.inserts[0][6], 'qr-1');
    assert.equal(db.connEvents.length, 1);
    assert.deepEqual([db.connEvents[0][0], db.connEvents[0][2]], ['qr', 'send_qr_ok']);
    assert.match(db.connEvents[0][3], /to=5511999999999/);
  });

  it('registra falha (channel=qr) quando o envio QR falha', async () => {
    const db = makeDb({ cfg: { ...CFG_CLOUD, access_token: null, phone_number_id: null } });
    const qr = { qrReady: () => true, sendText: async () => ({ ok: false, error: 'client_not_ready' }) };
    const notifier = createWhatsAppNotifier({ db, log, qr });
    await notifier.notifyIncident(incident);
    assert.equal(db.inserts.length, 1);
    assert.equal(db.inserts[0][8], 'qr');
    assert.equal(db.inserts[0][4], 'failed');
    assert.match(db.inserts[0][5], /client_not_ready/);
    assert.equal(db.connEvents.length, 1);
    assert.deepEqual([db.connEvents[0][0], db.connEvents[0][2]], ['qr', 'send_qr_fail']);
    assert.match(db.connEvents[0][3], /client_not_ready/);
  });

  it('sem Cloud e sem QR pronto, mantém comportamento atual (tenta Cloud e falha)', async () => {
    const db = makeDb({ cfg: { ...CFG_CLOUD, access_token: null } });
    const qr = { qrReady: () => false, sendText: async () => ({ ok: true }) };
    const notifier = createWhatsAppNotifier({ db, log, qr });
    await notifier.notifyIncident(incident);
    assert.equal(db.inserts.length, 1);
    assert.equal(db.inserts[0][8], 'cloud');
    assert.equal(db.inserts[0][4], 'failed');
    assert.equal(db.connEvents.length, 1);
    assert.deepEqual([db.connEvents[0][0], db.connEvents[0][2]], ['cloud', 'send_cloud_fail']);
  });

  it('registra send_cloud_fail com a mensagem da Meta (HTTP) no detail', async () => {
    const db = makeDb();
    const notifier = createWhatsAppNotifier({ db, log, qr: null });
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) });
    try {
      await notifier.notifyIncident(incident);
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(db.connEvents.length, 1);
    assert.deepEqual([db.connEvents[0][0], db.connEvents[0][2]], ['cloud', 'send_cloud_fail']);
    assert.match(db.connEvents[0][3], /Invalid OAuth access token/);
  });

  it('não envia nada quando o toggle de notificações está desligado', async () => {
    const db = makeDb({ cfg: { ...CFG_CLOUD, enabled: false } });
    const qr = { qrReady: () => true, sendText: async () => ({ ok: true }) };
    const notifier = createWhatsAppNotifier({ db, log, qr });
    await notifier.notifyIncident(incident);
    assert.equal(db.inserts.length, 0);
    assert.equal(db.connEvents.length, 0);
  });
});

function makeQrDb({ row = null } = {}) {
  const updates = [];
  const connEvents = [];
  return {
    updates,
    connEvents,
    async query(sql, params) {
      if (sql.includes('UPDATE observe_whatsapp_qr_connections')) {
        updates.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT enabled, desired_state FROM observe_whatsapp_qr_connections')) {
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('INSERT INTO observe_whatsapp_messages')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO observe_whatsapp_connection_events')) {
        connEvents.push(params);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function fakeBridge() {
  const listeners = {};
  const calls = { add: 0, requestQr: 0, disconnect: 0 };
  return {
    calls,
    listeners,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, payload) { (listeners[ev] || []).forEach((fn) => fn(payload)); },
    async addConnection() { calls.add++; return { ok: true }; },
    async requestQr() { calls.requestQr++; return { ok: true, pending: true }; },
    async disconnect() { calls.disconnect++; return { ok: true }; },
    getStatus(id) {
      return calls.add + calls.requestQr > 0
        ? { ok: true, connectionId: id, status: 'ready', ready: true }
        : { ok: false, error: 'not_found' };
    },
    async sendText() { return { ok: true, externalMessageId: 'x' }; },
    async stop() {},
  };
}

describe('WhatsApp QR service (worker)', () => {
  it('não sobe sem WHATSAPP_QR_ENABLED=true', () => {
    const svc = createWhatsAppQrService({ db: makeQrDb(), log, env: {} });
    assert.equal(svc.start(), false);
    assert.equal(svc.qrReady(), false);
  });

  it('aplica comando connected: cria a conexão no bridge (primeira vez)', async () => {
    const bridge = fakeBridge();
    const svc = createWhatsAppQrService({
      db: makeQrDb({ row: { enabled: true, desired_state: 'connected' } }),
      log,
      env: { WHATSAPP_QR_ENABLED: 'true' },
      createBridgeImpl: () => bridge,
    });
    await svc.pollOnce();
    assert.equal(bridge.calls.add, 1);
    assert.equal(bridge.calls.requestQr, 0);
    assert.equal(svc.qrReady(), true);
    // comando repetido não reage de novo
    await svc.pollOnce();
    assert.equal(bridge.calls.add, 1);
  });

  it('reativação (disconnect→connect) força novo QR via requestQr', async () => {
    const bridge = fakeBridge();
    const db = makeQrDb({ row: { enabled: true, desired_state: 'connected' } });
    const svc = createWhatsAppQrService({ db, log, env: { WHATSAPP_QR_ENABLED: 'true' }, createBridgeImpl: () => bridge });
    await svc.pollOnce();
    assert.equal(bridge.calls.add, 1);

    db.query = (orig => async function (sql, params) {
      if (sql.includes('SELECT enabled, desired_state')) return { rowCount: 1, rows: [{ enabled: true, desired_state: 'disconnected' }] };
      return orig(sql, params);
    })(db.query);
    await svc.pollOnce();
    assert.equal(bridge.calls.disconnect, 1);

    db.query = (orig => async function (sql, params) {
      if (sql.includes('SELECT enabled, desired_state')) return { rowCount: 1, rows: [{ enabled: true, desired_state: 'connected' }] };
      return orig(sql, params);
    })(db.query);
    await svc.pollOnce();
    assert.equal(bridge.calls.requestQr, 1);
  });

  it('enabled=false na tabela derruba a sessão mesmo com desired_state=connected', async () => {
    const bridge = fakeBridge();
    const db = makeQrDb({ row: { enabled: true, desired_state: 'connected' } });
    const svc = createWhatsAppQrService({ db, log, env: { WHATSAPP_QR_ENABLED: 'true' }, createBridgeImpl: () => bridge });
    await svc.pollOnce();
    db.query = (orig => async function (sql, params) {
      if (sql.includes('SELECT enabled, desired_state')) return { rowCount: 1, rows: [{ enabled: false, desired_state: 'connected' }] };
      return orig(sql, params);
    })(db.query);
    await svc.pollOnce();
    assert.equal(bridge.calls.disconnect, 1);
  });

  it('persiste QR, status e erro do bridge na tabela', async () => {
    const bridge = fakeBridge();
    const db = makeQrDb({ row: { enabled: true, desired_state: 'connected' } });
    const svc = createWhatsAppQrService({ db, log, env: { WHATSAPP_QR_ENABLED: 'true' }, createBridgeImpl: () => bridge });
    await svc.pollOnce();

    bridge.emit('qr', { connectionId: 'default', qrText: 'qr-text', qrDataUrl: 'data:image/png;base64,x', expiresAt: '2026-01-01T00:00:00Z' });
    await new Promise((r) => setImmediate(r));
    const qrUpdate = db.updates.find((u) => u.sql.includes('qr_data_url'));
    assert.ok(qrUpdate, 'esperava UPDATE com qr_data_url');
    assert.equal(qrUpdate.params[0], 'pairing');

    bridge.emit('status', { connectionId: 'default', status: 'ready' });
    await new Promise((r) => setImmediate(r));
    const stUpdate = db.updates.find((u) => u.params.includes('ready'));
    assert.ok(stUpdate, 'esperava UPDATE com status ready');

    bridge.emit('error', { connectionId: 'default', error: 'falhou' });
    await new Promise((r) => setImmediate(r));
    assert.ok(db.updates.some((u) => u.sql.includes('last_error')));
  });

  it('grava mensagem recebida como inbound/channel=qr na auditoria', async () => {
    const bridge = fakeBridge();
    const inserts = [];
    const db = makeQrDb({ row: { enabled: true, desired_state: 'connected' } });
    const origQuery = db.query;
    db.query = async (sql, params) => {
      if (sql.includes('INSERT INTO observe_whatsapp_messages')) { inserts.push(params); return { rowCount: 1, rows: [] }; }
      return origQuery(sql, params);
    };
    const svc = createWhatsAppQrService({ db, log, env: { WHATSAPP_QR_ENABLED: 'true' }, createBridgeImpl: () => bridge });
    await svc.pollOnce();
    bridge.emit('message', { connectionId: 'default', from: '5511999999999@c.us', body: 'status', hasMedia: false });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(inserts.length, 1);
    assert.deepEqual([inserts[0][0], inserts[0][1], inserts[0][8]], ['in', 'inbound', 'qr']);
    assert.equal(inserts[0][4], 'received');
  });

  it('registra ciclo de vida no log de conexões (command_applied, qr, status, ready, error)', async () => {
    const bridge = fakeBridge();
    const db = makeQrDb({ row: { enabled: true, desired_state: 'connected' } });
    const svc = createWhatsAppQrService({ db, log, env: { WHATSAPP_QR_ENABLED: 'true' }, createBridgeImpl: () => bridge });
    await svc.pollOnce();
    await new Promise((r) => setImmediate(r));

    // params: [channel, connection_id, event, detail]
    const events = () => db.connEvents.map((p) => p[2]);
    assert.ok(events().includes('command_applied'));
    assert.equal(db.connEvents.find((p) => p[2] === 'command_applied')[3], 'desired_state=connected');

    bridge.emit('qr', { connectionId: 'default', qrText: 'qr-text-secreto', qrDataUrl: 'data:image/png;base64,x', expiresAt: '2026-01-01T00:00:00Z' });
    bridge.emit('status', { connectionId: 'default', status: 'connected' });
    bridge.emit('ready', { connectionId: 'default' });
    bridge.emit('status', { connectionId: 'default', status: 'disconnected', reason: 'NAVIGATION' });
    bridge.emit('error', { connectionId: 'default', error: 'initialize_failed' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const qrEv = db.connEvents.find((p) => p[2] === 'qr_generated');
    assert.ok(qrEv, 'esperava qr_generated');
    assert.match(qrEv[3], /expires_at=2026-01-01T00:00:00Z/);
    assert.ok(!qrEv[3].includes('qr-text-secreto'), 'detail não pode conter o texto do QR');

    const stEvents = db.connEvents.filter((p) => p[2] === 'status_changed').map((p) => p[3]);
    assert.ok(stEvents.some((d) => d === 'status=connected'));
    assert.ok(stEvents.some((d) => d.includes('status=disconnected') && d.includes('reason=NAVIGATION')));

    assert.ok(events().includes('ready'));
    const errEv = db.connEvents.find((p) => p[2] === 'error');
    assert.ok(errEv, 'esperava error');
    assert.match(errEv[3], /initialize_failed/);
    // todos no canal qr, conexão default
    assert.ok(db.connEvents.every((p) => p[0] === 'qr' && p[1] === 'default'));
  });

  it('registra service_started ao subir o serviço', async () => {
    const db = makeQrDb();
    const svc = createWhatsAppQrService({ db, log, env: { WHATSAPP_QR_ENABLED: 'true', WHATSAPP_QR_AUTH_PATH: '/tmp/wa-auth' }, createBridgeImpl: () => fakeBridge(), pollMs: 60000 });
    assert.equal(svc.start(), true);
    await svc.stop();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const ev = db.connEvents.find((p) => p[2] === 'service_started');
    assert.ok(ev, 'esperava service_started');
    assert.match(ev[3], /authDataPath=\/tmp\/wa-auth/);
    assert.match(ev[3], /pollMs=60000/);
  });

  it('registra lock_cleared quando o bridge avisa remoção de lock via logger', async () => {
    const bridge = fakeBridge();
    let bridgeOpts = null;
    const db = makeQrDb({ row: { enabled: true, desired_state: 'connected' } });
    const svc = createWhatsAppQrService({
      db, log,
      env: { WHATSAPP_QR_ENABLED: 'true' },
      createBridgeImpl: (opts) => { bridgeOpts = opts; return bridge; },
    });
    await svc.pollOnce();
    assert.ok(bridgeOpts && bridgeOpts.logger, 'logger do bridge não capturado');
    bridgeOpts.logger.info('[whatsapp-qr-bridge] Lock do Chrome removido', { lockPath: '/var/lib/r-observe/whatsapp-auth/session-waqr_default/SingletonLock' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const ev = db.connEvents.find((p) => p[2] === 'lock_cleared');
    assert.ok(ev, 'esperava lock_cleared');
    assert.match(ev[3], /SingletonLock/);
  });
});
