'use strict';

/**
 * @results/whatsapp-qr-bridge
 *
 * Núcleo de bridge WhatsApp via QR Code (whatsapp-web.js), generalizado a
 * partir do r-agent2 (api/services/whatsappQrBridgeService.js).
 *
 * O pacote NÃO toca banco de dados, tenant_settings, WebSocket ou tickets:
 * tudo isso é responsabilidade do consumidor, que reage aos eventos emitidos
 * (qr/status/ready/message/error) e persiste o que precisar.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const QR_CODE = require('qrcode');

const STATUS = Object.freeze(['pairing', 'connected', 'ready', 'disconnected', 'error']);

const DEFAULT_SYNC_INTERVAL_MS = 30000;
const DEFAULT_QR_EXPIRES_IN_MS = 2 * 60 * 1000;
const DEFAULT_SEND_TIMEOUT_MS = 60 * 1000;
const DEFAULT_READY_WATCHDOG_MS = 60 * 1000;
const READY_WATCHDOG_MAX_ATTEMPTS = 3;

/**
 * Suporte a pin de versão do WhatsApp Web (workaround para quebras da lib
 * como o wwebjs#127084, em que `authenticated` dispara mas `ready` nunca).
 *
 * ATENÇÃO: pin só funciona enquanto o WhatsApp mantiver os assets do build
 * no CDN — builds antigos são removidos e a página morre no boot (sem CSS,
 * `auth timeout`). Por isso o default é NÃO pinar: usa o WA Web mais recente
 * e cabe à dependência whatsapp-web.js estar atualizada (usamos o main).
 *
 *   - webVersion undefined/null/false/'' → sem pin (WA Web latest; default);
 *   - webVersion '<versao>'              → pin custom; exige `<versao>.html`
 *                                          em webVersionCacheDir (default:
 *                                          wa-web/ do pacote, se existir).
 */
const WA_WEB_CACHE_DIR = path.join(__dirname, '..', 'wa-web');

/**
 * Resolve as opções `webVersion`/`webVersionCache` para o Client do
 * whatsapp-web.js. Retorna {} quando não há pin (comportamento nativo da lib).
 *
 * Com `dataPath` informado e SEM pin, retorna apenas um `webVersionCache`
 * local em diretório gravável ao lado da sessão: sem isso a lib usa
 * './.wwebjs_cache' (relativo ao CWD) e o persist pós-authenticated morre
 * com EACCES em container (CWD read-only), abortando o handler ANTES do
 * LoadUtils — sessão presa em 'connected' sem erro (prod, ago/2026). O
 * resolve() interno da lib continua sem pin: pede a versão default antiga,
 * não acha no cache e serve a latest.
 */
function resolveWebVersionOptions({ webVersion, webVersionCacheDir, dataPath } = {}) {
  if (webVersion === null || webVersion === false) {
    return dataPath ? { webVersionCache: { type: 'local', path: path.join(path.resolve(safeTrim(dataPath)), '.wwebjs_cache') } } : {};
  }
  const version = safeTrim(webVersion);
  if (!version) {
    return dataPath ? { webVersionCache: { type: 'local', path: path.join(path.resolve(safeTrim(dataPath)), '.wwebjs_cache') } } : {};
  }
  const cacheDir = path.resolve(safeTrim(webVersionCacheDir) || WA_WEB_CACHE_DIR);
  return { webVersion: version, webVersionCache: { type: 'local', path: cacheDir } };
}

/**
 * Resolve o user-agent do Client do whatsapp-web.js.
 *
 * Motivo: o default da lib é um fingerprint congelado (Chrome 101 em
 * macOS 10.14, de 2022). Desde o endurecimento anti-automação da Meta
 * (2025-11 em diante), sessões pareadas com esse UA impossível (binário
 * real Chrome 14x + UA Chrome 101) são derrubadas com LOGOUT minutos após
 * o pareamento — verificado em prod e local (ago/2026), enquanto o WA Web
 * oficial (UA real do browser) permanece estável.
 *
 *   - userAgent undefined/'auto' → detecta a versão real do binário do
 *     Chrome (`--version`) e monta um UA coerente com a plataforma;
 *     fallback: false (UA genuíno do binário, sem spoof da lib);
 *   - userAgent 'default'        → undefined (spoof nativo da lib — escape
 *                                  hatch para comparar comportamento);
 *   - userAgent false            → false (desliga o spoof da lib);
 *   - qualquer outra string      → usada como está.
 */
function resolveUserAgent({ userAgent, executablePath } = {}) {
  if (userAgent === false) return false;
  const raw = safeTrim(userAgent);
  if (raw && raw.toLowerCase() === 'default') return undefined;
  if (raw && raw.toLowerCase() !== 'auto') return raw;
  const detected = detectChromeVersion(executablePath);
  if (!detected) return false;
  const platform = {
    linux: 'X11; Linux x86_64',
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
    win32: 'Windows NT 10.0; Win64; x64',
  }[process.platform] || 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${detected} Safari/537.36`;
}

/**
 * Descobre a versão real do Chrome/Chromium: primeiro o executablePath
 * informado, depois o cache do puppeteer (PUPPETEER_CACHE_DIR ou
 * ~/.cache/puppeteer) e por fim binários comuns do sistema.
 */
function detectChromeVersion(executablePath) {
  const candidates = [];
  const explicit = safeTrim(executablePath);
  if (explicit) candidates.push(explicit);
  const cacheDir = safeTrim(process.env.PUPPETEER_CACHE_DIR) || path.join(process.env.HOME || '/root', '.cache', 'puppeteer');
  const globDirs = [path.join(cacheDir, 'chrome'), path.join(cacheDir, 'chrome-headless-shell')];
  for (const base of globDirs) {
    try {
      for (const entry of fs.readdirSync(base).sort().reverse()) {
        candidates.push(path.join(base, entry, 'chrome-linux64', 'chrome'));
        candidates.push(path.join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      }
    } catch (_) {}
  }
  candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  for (const bin of candidates) {
    try {
      const out = require('child_process').execFileSync(bin, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = safeToString(out).match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) return m[1];
    } catch (_) {}
  }
  return null;
}

function safeToString(value, fallback = '') {
  if (value == null) return fallback;
  try { return String(value); } catch (_) { return fallback; }
}

function safeTrim(value, fallback = '') {
  return safeToString(value, fallback).trim();
}

function safeErrorMessage(err, fallback = '') {
  try {
    const message = err && typeof err === 'object' ? err.message : null;
    return safeToString(message) || safeToString(err, fallback);
  } catch (_) {
    return safeToString(err, fallback);
  }
}

/**
 * Normaliza o destino para o formato do WhatsApp Web: `<digits>@c.us`.
 * Se já contém '@', é devolvido como está (ex.: grupos `<id>@g.us`).
 */
function normalizeDestination(to) {
  const raw = safeTrim(to);
  if (!raw) return null;
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@c.us`;
}

function sanitizeClientId(connectionId) {
  return `waqr_${safeToString(connectionId)}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function extractExternalMessageId(sent) {
  if (!sent || typeof sent !== 'object') return null;
  const candidate = sent?.id?._serialized || sent?.id?.id || sent?.id || null;
  return candidate != null ? safeToString(candidate) : null;
}

/**
 * Remove arquivos de lock do Chrome (SingletonLock etc.) que ficam quando o
 * processo morre abruptamente e impedem nova inicialização do Puppeteer.
 */
function clearChromeLocks(dataPath, clientId, logger) {
  const sessionDir = path.join(dataPath, `session-${clientId}`);
  const locks = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];

  const removeIfPresent = (candidatePath) => {
    try {
      // lstat detecta o caminho mesmo quando é symlink quebrado.
      fs.lstatSync(candidatePath);
      fs.unlinkSync(candidatePath);
      logger.info('[whatsapp-qr-bridge] Lock do Chrome removido', { lockPath: candidatePath });
    } catch (_) {}
  };

  for (const lockFile of locks) {
    removeIfPresent(path.join(sessionDir, lockFile));
    removeIfPresent(path.join(sessionDir, 'Default', lockFile));
  }
}

function loadWhatsappWebJs() {
  try {
    // eslint-disable-next-line global-require
    const wa = require('whatsapp-web.js');
    if (!wa || typeof wa.Client !== 'function' || typeof wa.LocalAuth !== 'function') {
      throw new Error('whatsapp-web.js: Client ou LocalAuth não disponível');
    }
    return wa;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      '[whatsapp-qr-bridge] whatsapp-web.js é obrigatório em runtime, mas não foi instalado.\n' +
      'Instale no projeto consumidor com: npm install whatsapp-web.js\n' +
      `Erro: ${msg}`
    );
  }
}

function noopLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function normalizeLogger(logger) {
  const base = noopLogger();
  if (!logger || typeof logger !== 'object') return base;
  for (const level of ['info', 'warn', 'error', 'debug']) {
    if (typeof logger[level] === 'function') base[level] = logger[level].bind(logger);
  }
  return base;
}

/**
 * Factory padrão: cria `new Client` do whatsapp-web.js com LocalAuth.
 * O require é lazy para que testes (com clientFactory injetado) não puxem
 * puppeteer/Chrome.
 */
function defaultClientFactory({ clientId, dataPath, puppeteer, webVersion, webVersionCacheDir, userAgent, deviceName }) {
  const wa = loadWhatsappWebJs();
  const { Client, LocalAuth } = wa;
  return new Client({
    authStrategy: new LocalAuth({ clientId, dataPath }),
    ...(userAgent !== undefined ? { userAgent } : {}),
    // deviceName: nome do aparelho sugerido no pareamento (a lista de
    // "Aparelhos conectados" do WhatsApp não devolve esse nome ao cliente,
    // então fixá-lo é a única forma de a sessão ser auto-identificável).
    ...(deviceName ? { deviceName } : {}),
    puppeteer: puppeteer || {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
    // dataPath: sem pin, garante webVersionCache em dir gravável (sem isso o
    // persist pós-authenticated morre com EACCES em CWD read-only e a sessão
    // fica presa em 'connected' — ver resolveWebVersionOptions).
    ...resolveWebVersionOptions({ webVersion, webVersionCacheDir, dataPath }),
  });
}

function createBridge(options = {}) {
  const logger = normalizeLogger(options.logger);
  const authDataPath = path.resolve(safeTrim(options.authDataPath) || '.wwebjs_auth');
  const clientFactory = typeof options.clientFactory === 'function' ? options.clientFactory : defaultClientFactory;
  // Resolvido uma vez: a detecção executa o binário do Chrome (--version).
  const resolvedUserAgent = resolveUserAgent({
    userAgent: options.userAgent,
    executablePath: options.puppeteer && options.puppeteer.executablePath,
  });
  const qrExpiresInMs = Number.isFinite(Number(options.qrExpiresInMs)) && Number(options.qrExpiresInMs) > 0
    ? Number(options.qrExpiresInMs)
    : DEFAULT_QR_EXPIRES_IN_MS;
  // Timeout de envio (default 60s; 0 desliga). Sessão morta remotamente (ex.:
  // aparelho removido em "Aparelhos conectados") pode não disparar evento —
  // o cliente fica zumbi, pronto na tela, e o sendMessage trava para sempre
  // (verificado em prod, ago/2026). No timeout o cliente é destruído e o sync
  // o reinicia: sessão inválida gera QR novo, sessão válida volta ao ready.
  const sendTimeoutMs = options.sendTimeoutMs === undefined
    ? DEFAULT_SEND_TIMEOUT_MS
    : Math.max(0, Number(options.sendTimeoutMs) || 0);

  // Watchdog anti-race do wwebjs: `authenticated` dispara mas a injeção do
  // WWebJS (LoadUtils) falha uma única vez no meio do sync e a lib não tenta
  // de novo — a sessão fica presa em 'connected' para sempre (visto em prod
  // ago/2026, WA Web 2.3000.1045288154 + wwebjs main 942d236). O kick chama
  // window.onAppStateHasSyncedEvent(), que refaz o fluxo de injeção da lib.
  // 0 desliga. Default: DEFAULT_READY_WATCHDOG_MS.
  let readyWatchdogMs = DEFAULT_READY_WATCHDOG_MS;
  if (options.readyWatchdogMs != null) {
    const n = Number(options.readyWatchdogMs);
    readyWatchdogMs = Number.isFinite(n) && n >= 0 ? n : DEFAULT_READY_WATCHDOG_MS;
  }

  let syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
  if (options.syncIntervalMs != null) {
    const n = Number(options.syncIntervalMs);
    syncIntervalMs = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SYNC_INTERVAL_MS;
  }

  const emitter = new EventEmitter();
  // Map<connectionId, entry>
  // entry: { id, sessionPath, clientId, status, client, ready, desiredActive, createdAt, updatedAt, readyWatchdogTimer, readyWatchdogAttempts }
  const connections = new Map();
  let syncTimer = null;
  let starting = null; // Map<connectionId, Promise> — evita inicializações concorrentes

  function setStatus(entry, status, extra = {}) {
    if (!STATUS.includes(status)) return;
    entry.status = status;
    entry.updatedAt = new Date().toISOString();
    emitter.emit('status', { connectionId: entry.id, status, ...extra });
  }

  function snapshot(entry) {
    return {
      id: entry.id,
      clientId: entry.clientId,
      status: entry.status,
      ready: entry.ready === true,
      sessionPath: entry.sessionPath,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  async function destroyClient(entry) {
    clearReadyWatchdog(entry);
    const client = entry.client;
    entry.client = null;
    entry.ready = false;
    if (client && typeof client.destroy === 'function') {
      try { await client.destroy(); } catch (_) {}
    }
  }

  function clearReadyWatchdog(entry) {
    if (entry.readyWatchdogTimer) {
      clearTimeout(entry.readyWatchdogTimer);
      entry.readyWatchdogTimer = null;
    }
  }

  function armReadyWatchdog(entry, client) {
    // Já armado: sai. O kick chama onAppStateHasSyncedEvent, que faz a lib
    // re-emitir 'authenticated' no meio do evaluate do tick — sem esta guarda
    // (e sem a do fim do tick) cada eco arma um timer novo e os kicks se
    // multiplicam (visto em prod: 3 kicks no mesmo segundo).
    if (entry.readyWatchdogTimer) return;
    if (!readyWatchdogMs) return;
    const tick = async () => {
      entry.readyWatchdogTimer = null;
      if (entry.ready || entry.client !== client) return;
      if (entry.readyWatchdogAttempts >= READY_WATCHDOG_MAX_ATTEMPTS) {
        logger.warn('[whatsapp-qr-bridge] ready não disparou após authenticated; tentativas de re-injeção esgotadas', {
          connectionId: entry.id,
          attempts: READY_WATCHDOG_MAX_ATTEMPTS,
        });
        return;
      }
      entry.readyWatchdogAttempts += 1;
      logger.warn('[whatsapp-qr-bridge] ready não disparou após authenticated; forçando re-injeção do WWebJS', {
        connectionId: entry.id,
        attempt: entry.readyWatchdogAttempts,
      });
      try {
        const page = client.pupPage;
        if (page && typeof page.evaluate === 'function') {
          await page.evaluate(() => {
            if (typeof window.onAppStateHasSyncedEvent === 'function') {
              return window.onAppStateHasSyncedEvent();
            }
            return null;
          });
        }
      } catch (err) {
        logger.warn('[whatsapp-qr-bridge] Falha no kick de re-injeção', { connectionId: entry.id, error: safeErrorMessage(err) });
      }
      if (!entry.ready && entry.client === client && !entry.readyWatchdogTimer) {
        entry.readyWatchdogTimer = setTimeout(tick, readyWatchdogMs);
        if (entry.readyWatchdogTimer.unref) entry.readyWatchdogTimer.unref();
      }
    };
    entry.readyWatchdogTimer = setTimeout(tick, readyWatchdogMs);
    if (entry.readyWatchdogTimer.unref) entry.readyWatchdogTimer.unref();
  }

  function wireClientEvents(entry, client) {
    client.on('qr', async (qrText) => {
      setStatus(entry, 'pairing');
      let qrDataUrl = null;
      try {
        qrDataUrl = await QR_CODE.toDataURL(safeToString(qrText));
      } catch (err) {
        logger.warn('[whatsapp-qr-bridge] Falha ao gerar data URL do QR', { error: safeErrorMessage(err) });
      }
      emitter.emit('qr', {
        connectionId: entry.id,
        qrText: safeToString(qrText),
        qrDataUrl,
        expiresAt: new Date(Date.now() + qrExpiresInMs).toISOString(),
      });
    });

    client.on('authenticated', () => {
      setStatus(entry, 'connected');
      armReadyWatchdog(entry, client);
    });

    client.on('ready', () => {
      clearReadyWatchdog(entry);
      entry.ready = true;
      setStatus(entry, 'ready');
      // Recuperação de não-lidas é acoplada a tickets e fica fora do núcleo:
      // o consumidor decide o que fazer ao receber este evento.
      emitter.emit('ready', { connectionId: entry.id });
    });

    client.on('disconnected', async (reason) => {
      setStatus(entry, 'disconnected', { reason: reason ? safeToString(reason) : null });
      await destroyClient(entry);
    });

    client.on('auth_failure', (msg) => {
      const error = msg ? safeToString(msg) : 'auth_failure';
      setStatus(entry, 'error', { reason: error });
      emitter.emit('error', { connectionId: entry.id, error });
    });

    client.on('message', (message) => {
      if (message?.fromMe) return;
      emitter.emit('message', {
        connectionId: entry.id,
        from: safeTrim(message?.from || ''),
        body: safeToString(message?.body || ''),
        hasMedia: message?.hasMedia === true,
        raw: message,
      });
    });

    // Recibos de entrega/leitura das mensagens enviadas pela sessão.
    // ack numérico do wwebjs: 1=sent, 2=delivered, 3=read, 4=played.
    // O messageId é o id serializado (id._serialized) — o mesmo devolvido
    // como externalMessageId no sendText/sendMedia, permitindo correlacionar.
    client.on('message_ack', (message, ack) => {
      const messageId = message && message.id && message.id._serialized
        ? String(message.id._serialized)
        : null;
      if (!messageId) return;
      emitter.emit('ack', {
        connectionId: entry.id,
        messageId,
        ack: Number(ack),
        to: safeTrim(message?.to || ''),
      });
    });
  }

  async function startClient(entry) {
    if (entry.client) return { ok: true, alreadyActive: true };
    if (starting && starting.has(entry.id)) return starting.get(entry.id);

    const promise = (async () => {
      const dataPath = path.resolve(entry.sessionPath || authDataPath);
      try { fs.mkdirSync(dataPath, { recursive: true }); } catch (_) {}

      let client;
      try {
        client = clientFactory({
          clientId: entry.clientId,
          dataPath,
          connectionId: entry.id,
          puppeteer: options.puppeteer,
          webVersion: options.webVersion,
          webVersionCacheDir: options.webVersionCacheDir,
          userAgent: resolvedUserAgent,
          deviceName: safeTrim(options.deviceName) || undefined,
        });
      } catch (err) {
        const message = safeErrorMessage(err, 'client_factory_failed');
        setStatus(entry, 'error', { reason: message });
        emitter.emit('error', { connectionId: entry.id, error: message });
        return { ok: false, error: 'client_factory_failed', message };
      }

      wireClientEvents(entry, client);
      // Registra antes do initialize() para que o handler de 'ready' marque ready=true.
      entry.client = client;
      entry.ready = false;
      entry.readyWatchdogAttempts = 0;
      if (!STATUS.includes(entry.status) || entry.status === 'disconnected' || entry.status === 'error') {
        setStatus(entry, 'pairing');
      }

      try {
        clearChromeLocks(dataPath, entry.clientId, logger);
        await client.initialize();
        logger.info('[whatsapp-qr-bridge] Cliente inicializado', { connectionId: entry.id });
        return { ok: true, started: true };
      } catch (err) {
        const message = safeErrorMessage(err, 'initialize_failed');
        logger.error('[whatsapp-qr-bridge] Falha ao inicializar cliente', { connectionId: entry.id, error: message });
        setStatus(entry, 'error', { reason: message });
        emitter.emit('error', { connectionId: entry.id, error: message });
        await destroyClient(entry);
        return { ok: false, error: 'initialize_failed', message };
      }
    })();

    if (!starting) starting = new Map();
    starting.set(entry.id, promise);
    try {
      return await promise;
    } finally {
      starting.delete(entry.id);
    }
  }

  function requireConnection(id) {
    const connectionId = safeTrim(id);
    const entry = connectionId ? connections.get(connectionId) : null;
    if (!entry) return { ok: false, error: 'not_found' };
    return { ok: true, entry };
  }

  function requireReadyClient(id) {
    const found = requireConnection(id);
    if (!found.ok) return found;
    const { entry } = found;
    if (!entry.client || typeof entry.client.sendMessage !== 'function' || !entry.ready) {
      return { ok: false, error: 'client_not_ready', message: 'Aguardando sessão WhatsApp ficar pronta' };
    }
    return { ok: true, entry, client: entry.client };
  }

  /**
   * Envolve client.sendMessage com timeout anti-zumbi: se a sessão foi morta
   * remotamente sem evento, o envio trava indefinidamente — no timeout o
   * cliente é destruído (o sync o reinicia; sessão inválida gera QR novo).
   */
  function withSendTimeout(entry, sendPromise) {
    if (!sendTimeoutMs) return sendPromise;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const message = `send_timeout_${sendTimeoutMs}ms`;
        logger.warn('[whatsapp-qr-bridge] Envio travado — possível sessão zumbi, reiniciando cliente', { connectionId: entry.id, sendTimeoutMs });
        setStatus(entry, 'error', { reason: message });
        emitter.emit('error', { connectionId: entry.id, error: message });
        destroyClient(entry).catch(() => {});
        reject(new Error(message));
      }, sendTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      sendPromise.then(
        (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
        (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
      );
    });
  }

  async function syncConnections() {
    for (const entry of connections.values()) {
      if (entry.desiredActive && !entry.client && !(starting && starting.has(entry.id))) {
        // eslint-disable-next-line no-await-in-loop
        await startClient(entry).catch((err) => {
          logger.warn('[whatsapp-qr-bridge] Falha no sync (ignorado)', {
            connectionId: entry.id,
            error: safeErrorMessage(err),
          });
        });
      }
    }
  }

  function ensureSyncTimer() {
    if (syncIntervalMs <= 0 || syncTimer) return;
    syncTimer = setInterval(() => {
      syncConnections().catch((err) => {
        logger.warn('[whatsapp-qr-bridge] Falha no sync (ignorado)', { error: safeErrorMessage(err) });
      });
    }, syncIntervalMs);
    if (typeof syncTimer.unref === 'function') syncTimer.unref();
  }

  const bridge = {
    // Expõe o EventEmitter para o consumidor assinar os eventos.
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),

    /**
     * Registra uma conexão e inicia o cliente WhatsApp (QR chega via evento 'qr').
     */
    async addConnection({ id, sessionPath } = {}) {
      const connectionId = safeTrim(id);
      if (!connectionId) return { ok: false, error: 'invalid_id' };

      let entry = connections.get(connectionId);
      if (entry) {
        if (sessionPath) entry.sessionPath = path.resolve(safeTrim(sessionPath));
        entry.desiredActive = true;
        const started = await startClient(entry);
        ensureSyncTimer();
        return { ok: started.ok, alreadyRegistered: true, connection: snapshot(entry), ...(started.ok ? {} : { error: started.error, message: started.message }) };
      }

      const now = new Date().toISOString();
      entry = {
        id: connectionId,
        sessionPath: sessionPath ? path.resolve(safeTrim(sessionPath)) : null,
        clientId: sanitizeClientId(connectionId),
        status: 'pairing',
        client: null,
        ready: false,
        readyWatchdogTimer: null,
        readyWatchdogAttempts: 0,
        desiredActive: true,
        createdAt: now,
        updatedAt: now,
      };
      connections.set(connectionId, entry);
      setStatus(entry, 'pairing');

      const started = await startClient(entry);
      ensureSyncTimer();
      if (!started.ok) {
        return { ok: false, error: started.error, message: started.message, connection: snapshot(entry) };
      }
      return { ok: true, connection: snapshot(entry) };
    },

    /**
     * Remove a conexão do bridge, destruindo o cliente associado.
     */
    async removeConnection(id) {
      const found = requireConnection(id);
      if (!found.ok) return found;
      const { entry } = found;
      entry.desiredActive = false;
      connections.delete(entry.id);
      await destroyClient(entry);
      return { ok: true };
    },

    listConnections() {
      return Array.from(connections.values()).map(snapshot);
    },

    getStatus(id) {
      const found = requireConnection(id);
      if (!found.ok) return found;
      const { entry } = found;
      return {
        ok: true,
        connectionId: entry.id,
        status: entry.status,
        ready: entry.ready === true,
        updatedAt: entry.updatedAt,
      };
    },

    /**
     * Força (re)geração de QR: destrói o cliente atual (se houver) e inicia um
     * novo, o que dispara um novo evento 'qr' do whatsapp-web.js.
     */
    async requestQr(id) {
      const found = requireConnection(id);
      if (!found.ok) return found;
      const { entry } = found;
      entry.desiredActive = true;
      await destroyClient(entry);
      setStatus(entry, 'pairing');
      const started = await startClient(entry);
      ensureSyncTimer();
      if (!started.ok) return { ok: false, error: started.error, message: started.message };
      return { ok: true, pending: true };
    },

    async sendText(id, to, text) {
      const destination = normalizeDestination(to);
      if (!destination) return { ok: false, error: 'invalid_destination' };
      const messageText = safeToString(text);
      if (!safeTrim(messageText)) return { ok: false, error: 'empty_message' };

      const ready = requireReadyClient(id);
      if (!ready.ok) return ready;

      try {
        const sent = await withSendTimeout(ready.entry, ready.client.sendMessage(destination, messageText));
        return { ok: true, connectionId: ready.entry.id, externalMessageId: extractExternalMessageId(sent) };
      } catch (err) {
        return { ok: false, error: 'qr_send_failed', message: safeErrorMessage(err, 'qr_send_failed') };
      }
    },

    /**
     * Envia mídia. `data` é base64 (string) ou Buffer.
     */
    async sendMedia(id, to, { data, mimeType, fileName, caption } = {}) {
      const destination = normalizeDestination(to);
      if (!destination) return { ok: false, error: 'invalid_destination' };

      const b64 = Buffer.isBuffer(data) ? data.toString('base64') : safeTrim(data);
      if (!b64) return { ok: false, error: 'invalid_media' };
      const mime = safeTrim(mimeType) || 'application/octet-stream';
      const name = safeTrim(fileName) || `media-${Date.now()}`;

      const ready = requireReadyClient(id);
      if (!ready.ok) return ready;

      // Usa MessageMedia do whatsapp-web.js quando disponível; com clientFactory
      // injetado (testes), cai num objeto simples equivalente.
      let media;
      try {
        const wa = loadWhatsappWebJs();
        media = new wa.MessageMedia(mime, b64, name);
      } catch (_) {
        media = { mimetype: mime, data: b64, filename: name };
      }

      const captionText = safeTrim(safeToString(caption));
      const sendOpts = captionText ? { caption: captionText } : undefined;

      try {
        const sent = await withSendTimeout(ready.entry, ready.client.sendMessage(destination, media, sendOpts));
        return { ok: true, connectionId: ready.entry.id, externalMessageId: extractExternalMessageId(sent) };
      } catch (err) {
        return { ok: false, error: 'qr_send_failed', message: safeErrorMessage(err, 'qr_send_failed') };
      }
    },

    /**
     * Logout + destroy do cliente. A conexão permanece registrada, mas
     * marcada como inativa (o sync periódico não a reinicia).
     */
    async disconnect(id) {
      const found = requireConnection(id);
      if (!found.ok) return found;
      const { entry } = found;
      entry.desiredActive = false;
      const client = entry.client;
      if (client && typeof client.logout === 'function') {
        try { await client.logout(); } catch (_) {}
      }
      await destroyClient(entry);
      setStatus(entry, 'disconnected');
      return { ok: true };
    },

    /**
     * Para o sync periódico e destrói todos os clientes ativos.
     */
    async stop() {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      for (const entry of connections.values()) {
        entry.desiredActive = false;
        // eslint-disable-next-line no-await-in-loop
        await destroyClient(entry);
      }
      return { ok: true };
    },
  };

  return bridge;
}

module.exports = {
  createBridge,
  normalizeDestination,
  sanitizeClientId,
  resolveWebVersionOptions,
  resolveUserAgent,
  WA_WEB_CACHE_DIR,
  STATUS,
};
