'use strict';

/**
 * Canal WhatsApp via QR Code (whatsapp-web.js, não-oficial) — roda no worker.
 *
 * Comunicação API ↔ worker via tabela `observe_whatsapp_qr_connections`
 * (não há canal direto entre os processos): a API escreve `enabled` /
 * `desired_state` e lê `status`/`qr_*`; este serviço faz poll do comando
 * desejado e persiste os eventos do bridge (qr/status/error) na mesma linha.
 *
 * Ativação em duas camadas:
 *   1. env WHATSAPP_QR_ENABLED=true — sem ela o serviço nem sobe (bridge off);
 *   2. linha 'default' com enabled=true e desired_state='connected' — via UI/API.
 */

const { createWhatsAppMessageLog } = require('../shared/whatsapp-message-log');
const { createWhatsAppConnectionLog } = require('../shared/whatsapp-connection-log');

const DEFAULT_CONNECTION_ID = 'default';
const DEFAULT_AUTH_PATH = '/var/lib/r-observe/whatsapp-auth';
const DEFAULT_POLL_MS = 5000;

/**
 * Factory local do client whatsapp-web.js. O pacote bridge é instalado via
 * `file:` e, no container, o Node resolve o require a partir do path real do
 * pacote (/packages/whatsapp-qr-bridge), onde não há node_modules — por isso a
 * factory padrão não acha o whatsapp-web.js. Aqui o require resolve a partir
 * do node_modules do worker, que tem a dependência real. Lazy: só carrega
 * (puppeteer etc.) quando uma conexão é efetivamente criada.
 */
function workerClientFactory({ clientId, dataPath, puppeteer }) {
  // eslint-disable-next-line global-require
  const { Client, LocalAuth } = require('whatsapp-web.js');
  return new Client({
    authStrategy: new LocalAuth({ clientId, dataPath }),
    puppeteer: puppeteer || {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });
}

function createWhatsAppQrService({
  db,
  log,
  env = process.env,
  createBridgeImpl, // injetável p/ testes; default: require do pacote
  clientFactory,    // injetável p/ testes (repassado ao bridge)
  pollMs,
}) {
  const enabledByEnv = String(env.WHATSAPP_QR_ENABLED || '') === 'true';
  const authDataPath = env.WHATSAPP_QR_AUTH_PATH || DEFAULT_AUTH_PATH;
  const intervalMs = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0 ? Number(pollMs) : DEFAULT_POLL_MS;

  let bridge = null;
  let timer = null;
  let appliedDesired = null; // último desired_state efetivamente aplicado ao bridge

  // Log persistente de eventos de conexão (nunca lança; falha só gera warn).
  const connLog = createWhatsAppConnectionLog({ db, log });

  // Dedupe em memória do log de conexões: o WA Web renova o QR a cada ~20-30s
  // durante o pareamento e cada renovação dispara status 'pairing' + evento
  // 'qr' — sem dedupe, o log vira ruído mesmo sem ninguém escanear. Regras:
  //   - status_changed: só grava quando o status muda de fato;
  //   - qr_generated: no máximo 1 a cada QR_LOG_DEDUPE_MS, exceto se um
  //     status_changed foi gravado desde o último QR (novo ciclo real de
  //     pareamento: scan → connected/ready/disconnected/error sempre registram).
  // O estado é só em memória: após restart do worker, o primeiro evento grava.
  const QR_LOG_DEDUPE_MS = 5 * 60 * 1000;
  let lastRecordedStatus = null;
  let lastQrRecordedAt = 0;
  let statusRecordedSinceQr = false;

  async function persist(patch) {
    const sets = [];
    const params = [];
    for (const [col, val] of Object.entries(patch)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return;
    params.push(DEFAULT_CONNECTION_ID);
    try {
      await db.query(
        `UPDATE observe_whatsapp_qr_connections SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
        params,
      );
    } catch (e) {
      log('warn', 'WhatsApp QR: falha ao persistir estado', { err: e.message });
    }
  }

  function getBridge() {
    if (bridge) return bridge;
    const create = createBridgeImpl || require('@results/whatsapp-qr-bridge').createBridge;
    bridge = create({
      authDataPath,
      clientFactory: clientFactory || workerClientFactory,
      // Chrome em container com CPU limitada: o init do whatsapp-web.js estoura
      // o protocolTimeout default (180s) do puppeteer.
      puppeteer: {
        headless: true,
        protocolTimeout: 360000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
      logger: {
        info: (msg, extra) => {
          log('info', msg, extra);
          // O bridge remove locks órfãos do Chrome (SingletonLock etc.) antes do
          // initialize e avisa só via logger — espelhamos no log persistente.
          if (msg && String(msg).includes('Lock do Chrome removido')) {
            connLog.record({ channel: 'qr', event: 'lock_cleared', detail: (extra && extra.lockPath) || null });
          }
        },
        warn: (msg, extra) => log('warn', msg, extra),
        error: (msg, extra) => log('error', msg, extra),
        debug: () => {},
      },
    });

    bridge.on('qr', ({ qrText, qrDataUrl, expiresAt }) => {
      persist({ status: 'pairing', qr_text: qrText, qr_data_url: qrDataUrl, qr_expires_at: expiresAt || null, last_error: null });
      // Nunca gravar o texto/dataUrl do QR no log — só metadados.
      const now = Date.now();
      if (statusRecordedSinceQr || now - lastQrRecordedAt >= QR_LOG_DEDUPE_MS) {
        connLog.record({ channel: 'qr', event: 'qr_generated', detail: expiresAt ? `expires_at=${expiresAt}` : null });
        lastQrRecordedAt = now;
        statusRecordedSinceQr = false;
      }
    });
    bridge.on('status', ({ status, reason }) => {
      // QR some da tela quando a sessão conecta de vez.
      const patch = { status };
      if (status === 'ready' || status === 'disconnected') {
        patch.qr_text = null;
        patch.qr_data_url = null;
        patch.qr_expires_at = null;
      }
      persist(patch);
      if (status !== lastRecordedStatus) {
        lastRecordedStatus = status;
        statusRecordedSinceQr = true;
        connLog.record({ channel: 'qr', event: 'status_changed', detail: `status=${status}${reason ? ` reason=${reason}` : ''}` });
      }
    });
    bridge.on('ready', () => {
      connLog.record({ channel: 'qr', event: 'ready' });
    });
    bridge.on('error', ({ error }) => {
      const message = String(error || 'erro desconhecido').slice(0, 500);
      persist({ last_error: message });
      connLog.record({ channel: 'qr', event: 'error', detail: message });
    });
    bridge.on('message', ({ from, body }) => {
      createWhatsAppMessageLog({ db, log }).record({
        direction: 'in', kind: 'inbound', channel: 'qr',
        phone: from || null, body: body || null, status: 'received',
      });
    });
    return bridge;
  }

  async function readCommand() {
    try {
      const r = await db.query(
        'SELECT enabled, desired_state FROM observe_whatsapp_qr_connections WHERE id = $1',
        [DEFAULT_CONNECTION_ID],
      );
      return r.rowCount ? r.rows[0] : null;
    } catch (e) {
      log('warn', 'WhatsApp QR: falha ao ler comando', { err: e.message });
      return null;
    }
  }

  async function applyCommand(cmd) {
    const wantConnected = !!(cmd && cmd.enabled && cmd.desired_state === 'connected');
    const desiredKey = wantConnected ? 'connected' : 'disconnected';
    if (desiredKey === appliedDesired) return;
    // Marca ANTES do await: o boot do Chrome pode levar ~1min e o poll roda a
    // cada 5s — sem isto, cada poll reentraria aqui e reiniciaria o cliente
    // no meio da inicialização. Em falha, o sync do bridge (30s) retenta.
    appliedDesired = desiredKey;
    connLog.record({ channel: 'qr', event: 'command_applied', detail: `desired_state=${desiredKey}` });

    const b = getBridge();
    if (wantConnected) {
      // Limpa erro de uma tentativa anterior — a tela não deve mostrar erro velho.
      persist({ last_error: null });
      const st = b.getStatus(DEFAULT_CONNECTION_ID);
      // Primeira ativação registra a conexão; reativações forçam novo QR/sessão.
      const res = st.ok
        ? await b.requestQr(DEFAULT_CONNECTION_ID)
        : await b.addConnection({ id: DEFAULT_CONNECTION_ID });
      if (res && res.ok === false) {
        log('warn', 'WhatsApp QR: falha ao conectar', { err: res.error, detail: res.message });
        connLog.record({ channel: 'qr', event: 'error', detail: `${res.error || 'connect_failed'}${res.message ? `: ${res.message}` : ''}` });
      }
    } else {
      const st = b.getStatus(DEFAULT_CONNECTION_ID);
      if (st.ok) await b.disconnect(DEFAULT_CONNECTION_ID);
    }
  }

  async function pollOnce() {
    // Re-lê o comando após aplicar: se o usuário clicou durante a (lenta)
    // inicialização do Chrome, o novo comando é aplicado no mesmo ciclo.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const cmd = await readCommand();
      if (!cmd) return;
      const before = appliedDesired;
      // eslint-disable-next-line no-await-in-loop
      await applyCommand(cmd);
      if (appliedDesired === before) return; // estável
    }
  }

  function start() {
    if (!enabledByEnv) {
      log('info', 'WhatsApp QR: desabilitado (WHATSAPP_QR_ENABLED != true)');
      return false;
    }
    timer = setInterval(() => {
      pollOnce().catch((e) => log('warn', 'WhatsApp QR: poll falhou', { err: e.message }));
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    pollOnce().catch(() => {});
    log('info', 'WhatsApp QR: serviço iniciado', { authDataPath, pollMs: intervalMs });
    connLog.record({ channel: 'qr', event: 'service_started', detail: `authDataPath=${authDataPath} pollMs=${intervalMs}` });
    return true;
  }

  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (bridge) { try { await bridge.stop(); } catch (_) {} bridge = null; }
  }

  // Envio pelo canal QR (fallback quando a Cloud API não está configurada).
  function qrReady() {
    if (!bridge) return false;
    const st = bridge.getStatus(DEFAULT_CONNECTION_ID);
    return !!(st.ok && st.ready);
  }

  async function sendText(to, text) {
    if (!bridge) return { ok: false, error: 'qr_disabled' };
    return bridge.sendText(DEFAULT_CONNECTION_ID, to, text);
  }

  return { start, stop, pollOnce, qrReady, sendText, isEnabledByEnv: () => enabledByEnv };
}

module.exports = { createWhatsAppQrService, DEFAULT_CONNECTION_ID };
