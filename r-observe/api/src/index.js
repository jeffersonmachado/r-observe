'use strict';

const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const client = require('prom-client');
const icinga = require('./icinga');
const { createDbClient } = require('./db');
const { signInternalToken, requireScopeForJwt } = require('@results/auth');
const { createAuthMiddleware } = require('./middleware/auth');
const { LoginGuard } = require('./auth/login-guard');
const { RedisRateLimitStore } = require('./auth/redis-rate-limit-store');
const { validateBody } = require('./middleware/validate-body');
const bodySchemas = require('./schemas/api');
const { createCorsOptions } = require('./http/cors-options');
const { createAISettingsService } = require('./services/ai-settings');
const { createWhatsAppSettingsService } = require('./services/whatsapp-settings');
const { createWhatsAppQrService } = require('./services/whatsapp-qr');
const { createWhatsAppBot } = require('./services/whatsapp-bot');
const { createAIChatClient } = require('./services/ai-client');
const { createRagContext } = require('./services/rag-context');
const { sendWhatsAppMessage, validateAccessToken } = require('./shared/whatsapp');
const { createWhatsAppMessageLog } = require('./shared/whatsapp-message-log');
const { createWhatsAppConnectionLog } = require('./shared/whatsapp-connection-log');
const { createLifecycle } = require('./shared/lifecycle');
const { createHttpErrorHandler } = require('./shared/http-error-handler');
const { createAuditMiddleware } = require('./audit');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE = process.env.BASE_PATH || '/observe/api';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SESSION_COOKIE = process.env.OBSERVE_SESSION_COOKIE || 'observe_session';
const AI_SETTINGS_RECONCILE_INTERVAL_MS = parseInt(process.env.AI_SETTINGS_RECONCILE_INTERVAL_MS || '60000', 10);
const IS_DEV = process.env.NODE_ENV === 'development';
const VITE_DEV_ORIGIN = (process.env.VITE_DEV_ORIGIN || 'http://127.0.0.1:5177').replace(/\/+$/, '');
const AI_SETTINGS_RECONCILE_STRICT = String(
  process.env.AI_SETTINGS_RECONCILE_STRICT || (IS_DEV ? 'false' : 'true')
).toLowerCase() === 'true';
const OBSERVE_PROXY_ORIGIN = (process.env.OBSERVE_PROXY_ORIGIN || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const DISCOVERY_PROXY_ORIGIN = (
  process.env.DISCOVERY_PROXY_ORIGIN ||
  process.env.DISCOVERY_SERVICE_URL ||
  (IS_DEV ? 'http://127.0.0.1:3010' : OBSERVE_PROXY_ORIGIN)
).replace(/\/+$/, '');
const GRAFANA_URL = process.env.GRAFANA_PUBLIC_URL || '/grafana/';
const ICINGA_WEB_URL = process.env.ICINGA_WEB_PUBLIC_URL || '/icinga/';
const DISCOVERY_UI_URL = process.env.DISCOVERY_UI_PUBLIC_URL || '/observe/discovery';
const { VALID_AI_PROVIDERS, AI_AUTO_MODELS, AI_STATIC_MODELS } = require('./shared/ai-models');

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, msg, extra = {}) {
  if (level === 'debug' && LOG_LEVEL !== 'debug') return;
  process.stdout.write(JSON.stringify({ level, service: 'r-observe-api', msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

function logAIReconcileIssue(msg, extra = {}) {
  const err = new Error(msg);
  err.details = extra;
  const level = AI_SETTINGS_RECONCILE_STRICT ? 'error' : (extra.reason === 'interval' ? 'debug' : 'warn');
  log(level, msg, extra);
  if (AI_SETTINGS_RECONCILE_STRICT) throw err;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpRequestsTotal = new client.Counter({
  name: 'r_observe_api_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});
const eventsReceivedTotal = new client.Counter({
  name: 'r_observe_events_received_total',
  help: 'Total events received',
  labelNames: ['source'],
  registers: [register],
});
const activeIncidentsGauge = new client.Gauge({
  name: 'r_observe_active_incidents',
  help: 'Active (non-resolved) incidents',
  registers: [register],
});
const activeSessionsGauge = new client.Gauge({
  name: 'r_observe_active_sessions',
  help: 'Active user sessions',
  registers: [register],
});

// ─── Database ────────────────────────────────────────────────────────────────
const db = createDbClient(process.env);

// ─── Redis ────────────────────────────────────────────────────────────────────
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3, enableReadyCheck: true })
  : null;

if (redis) {
  redis.on('error', (err) => log('error', 'Redis error', { err: err.message }));
  redis.connect().catch((e) => log('warn', 'Redis initial connect failed', { err: e.message }));
}

const loginGuard = new LoginGuard(redis, {
  maxAttempts: parseInt(process.env.OBSERVE_LOGIN_MAX_ATTEMPTS || '5', 10),
  windowSeconds: parseInt(process.env.OBSERVE_LOGIN_WINDOW_SECONDS || '900', 10),
  lockSeconds: parseInt(process.env.OBSERVE_LOGIN_LOCK_SECONDS || '900', 10),
});

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

// Dev: Vite CLI serve os assets com HMR. Prod: express.static.
if (!IS_DEV) {
  app.use('/observe/api/ui', express.static(path.join(__dirname, '../public')));
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

function rewriteProxyLocation(value = '') {
  if (!value) return value;
  return value.replace(OBSERVE_PROXY_ORIGIN, '');
}

function rewriteDiscoveryDevPath(pathname) {
  return pathname.replace(/^\/observe\/discovery\/api\/discovery(?=\/|$)/, '/api/discovery');
}

async function devProxyToOrigin(req, res, origin, rewritePath = (pathValue) => pathValue) {
  const upstreamPath = rewritePath(req.originalUrl);
  const target = `${origin}${upstreamPath}`;
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await collectRequestBody(req);
    const headers = { ...req.headers, host: new URL(origin).host };
    delete headers.connection;
    delete headers['content-length'];

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length'].includes(lower)) return;
      const location = lower === 'location' ? rewriteProxyLocation(value).replace(origin, '') : value;
      res.setHeader(key, location);
    });

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    log('warn', 'Dev proxy failed', { path: req.originalUrl, target, err: e.message });
    res.status(502).json({ error: 'Dev proxy unavailable', detail: e.message });
  }
}

if (IS_DEV) {
  // Assets estáticos do Vite (sem auth)
  app.use(['/src', '/@vite', '/public', '/node_modules'], (req, res) => devProxyToOrigin(req, res, DISCOVERY_PROXY_ORIGIN));
  // Rotas autenticadas — mesmo em dev, exige sessao
  app.use(['/grafana', '/icinga', '/observe/discovery'], async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return res.redirect(`/observe/login?next=${encodeURIComponent(req.originalUrl)}`);
      const r = await db.query(
        `SELECT 1 FROM observe_sessions WHERE token_hash = $1 AND expires_at > NOW() LIMIT 1`,
        [sessionHash(token)]
      );
      if (!r.rowCount) return res.redirect(`/observe/login?next=${encodeURIComponent(req.originalUrl)}`);
      next();
    } catch (_) {
      return res.redirect(`/observe/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
  });
  app.use('/observe/discovery', (req, res) => devProxyToOrigin(req, res, DISCOVERY_PROXY_ORIGIN, rewriteDiscoveryDevPath));
  app.use(['/grafana', '/icinga'], (req, res) => devProxyToOrigin(req, res, OBSERVE_PROXY_ORIGIN));
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(cors(createCorsOptions(process.env.CORS_ORIGINS)));
app.use(express.json({
  limit: '512kb',
  verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf; },
}));

// ─── Middleware: request logging + metrics ────────────────────────────────────
app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequestsTotal.inc({ method: req.method, route: req.path, status: String(res.statusCode) });
    if (LOG_LEVEL === 'debug') log('debug', 'request', { method: req.method, path: req.path, status: res.statusCode });
  });
  next();
});

// ─── Auth + RBAC (extraído para middleware/auth.js) ──────────────────────────
const {
  init: initAuth,
  createAuthRoutes,
  requireAuth,
  requireAdmin,
  parseCookies,
  sessionHash,
  authenticateRequest,
} = createAuthMiddleware(db, SESSION_COOKIE, log, { loginGuard });

// Sessões humanas usam RBAC; identidades M2M precisam também do domínio explícito.
const requireAdminWrite = requireScopeForJwt('api:admin:write');
const requireInventoryWrite = requireScopeForJwt('api:inventory:write');
const requireDiscoveryWrite = requireScopeForJwt('api:discovery:write');
const requireAIWrite = requireScopeForJwt('api:ai:write');
const requireRemediationWrite = requireScopeForJwt('api:remediation:write');

// Páginas navegáveis devem conduzir o usuário ao login. O requireAuth continua
// retornando JSON 401 para APIs e clientes M2M.
function requireWebSession(req, res, next) {
  authenticateRequest(req).then((auth) => {
    if (!auth) {
      const nextPath = req.originalUrl.startsWith('/observe/') ? req.originalUrl : '/observe/home';
      return res.redirect(`/observe/login?next=${encodeURIComponent(nextPath)}`);
    }
    req.auth = auth;
    next();
  }).catch((error) => {
    log('warn', 'Web session validation failed', { err: error.message });
    res.redirect(`/observe/login?next=${encodeURIComponent(req.originalUrl || '/observe/home')}`);
  });
}

// ─── Rate limiters ────────────────────────────────────────────────────────────
const RL_WINDOW = parseInt(process.env.OBSERVE_RATE_LIMIT_WINDOW_MS || '60000', 10);
const eventLimiter = rateLimit({
  windowMs: RL_WINDOW,
  max: parseInt(process.env.OBSERVE_RATE_LIMIT_EVENTS_MAX || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore(redis, { prefix: 'r-observe:rate:events', windowMs: RL_WINDOW }),
});
const apiLimiter = rateLimit({
  windowMs: RL_WINDOW,
  max: parseInt(process.env.OBSERVE_RATE_LIMIT_API_MAX || '300', 10),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore(redis, { prefix: 'r-observe:rate:api', windowMs: RL_WINDOW }),
});

// ─── Auth endpoints centralizados em @results/auth ──────────────────────────
app.use(`${BASE}/auth/login`, apiLimiter);
app.use(createAuthRoutes(`${BASE}/auth`));

// ─── Serviços (extraídos para services/) ─────────────────────────────────────
const {
  proxyToAI,
  aiProxyFailureExtra,
  proxyToDiscovery,
  getPersistedAISettings,
  upsertPersistedAISettings,
  applyPersistedAISettingsOnStartup,
  reconcilePersistedAISettings,
  validateProviderKey,
  getProviderKeyStatus,
} = createAISettingsService({ db, log, logAIReconcileIssue, processEnv: process.env });

const whatsappSettings = createWhatsAppSettingsService({ db, log });
const whatsappQr = createWhatsAppQrService({ db, log });
const whatsappMsgLog = createWhatsAppMessageLog({ db, log });
const whatsappConnLog = createWhatsAppConnectionLog({ db, log });
const aiChatClient = createAIChatClient({
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://r-observe-ai:3000',
  signToken: signInternalToken,
  log,
});
const ragContext = createRagContext({ db, log });
const whatsappBot = createWhatsAppBot({ db, log, aiChat: aiChatClient.chat, ragContext });

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(createAuditMiddleware(db, log, { basePath: BASE }));

// Health
app.get(`${BASE}/health`, (_req, res) => {
  res.json({ status: 'ok', service: 'r-observe-api', version: '0.1.0' });
});

// Prometheus faz scrape pela rede interna. O proxy público bloqueia esta rota.
app.get(`${BASE}/metrics`, async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Status — verifica conectividade com DB e Redis
app.get(`${BASE}/status`, requireAuth, async (_req, res) => {
  const components = { api: 'ok', db: 'unknown', redis: 'unknown' };
  try { await db.query('SELECT 1'); components.db = 'ok'; }
  catch (e) { components.db = 'error'; log('warn', 'DB status check failed', { err: e.message }); }
  try {
    if (redis) { await redis.ping(); components.redis = 'ok'; }
    else { components.redis = 'disabled'; }
  } catch (e) { components.redis = 'error'; log('warn', 'Redis status check failed', { err: e.message }); }
  const healthy = components.db === 'ok';
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', components });
});

function explainTacticalVsAI(tactical, aiMetrics) {
  const reasons = [];

  reasons.push('Tactical mostra estado atual (snapshot) de hosts/serviços; IA mostra histórico de incidentes e remediações acumuladas.');

  if ((tactical.services.critical || 0) === 0 && (aiMetrics.pending_approval || 0) > 0) {
    reasons.push('Mesmo sem serviços críticos agora, há remediações pendentes de análises anteriores aguardando aprovação.');
  }

  if ((aiMetrics.failed || 0) > 0) {
    reasons.push('Falhas em IA/remediação são acumuladas no tempo e não refletem somente o estado operacional instantâneo do Tactical.');
  }

  if ((aiMetrics.total_analyzed || 0) > (tactical.services.total || 0)) {
    reasons.push('Total analisado pela IA conta eventos/incidentes ao longo do tempo, por isso pode ser maior que o total de serviços monitorados.');
  }

  return reasons;
}

async function getAIActivitySnapshot() {
  const [incidents, remediations, feedback, catalog] = await Promise.all([
    db.query(`
      SELECT i.id, i.title, i.severity, i.status, i.source,
             i.ai_summary, i.ai_cause, i.ai_suggestion, i.ai_pattern,
             h.name AS host_name, i.created_at, i.updated_at
      FROM observe_incidents i
      LEFT JOIN observe_hosts h ON i.host_id = h.id
      WHERE i.ai_summary IS NOT NULL
      ORDER BY i.updated_at DESC LIMIT 20`),
    db.query(`
      SELECT action, status, confidence_score, auto_executed, execution_output, requested_at
      FROM observe_remediations
      ORDER BY requested_at DESC LIMIT 20`),
    db.query(`
      SELECT rating, COUNT(*) AS count
      FROM observe_ai_feedback GROUP BY rating`),
    db.query(`
      SELECT action, description, risk, enabled, auto_ok, max_severity
      FROM observe_ai_catalog ORDER BY risk, action`),
  ]);

  const remRows = remediations.rows;
  const fbPos = feedback.rows.find(r => r.rating == 1)?.count || 0;
  const fbNeg = feedback.rows.find(r => r.rating == -1)?.count || 0;

  return {
    metrics: {
      total_analyzed: incidents.rowCount,
      auto_executed: remRows.filter(r => r.auto_executed).length,
      pending_approval: remRows.filter(r => r.status === 'pending_approval').length,
      succeeded: remRows.filter(r => r.status === 'executed').length,
      failed: remRows.filter(r => r.status === 'failed').length,
      feedback_positive: Number(fbPos),
      feedback_negative: Number(fbNeg),
    },
    recent_analyses: incidents.rows,
    recent_remediations: remRows,
    catalog: catalog.rows,
  };
}

app.get(`${BASE}/comparison/tactical-ai`, requireAuth, async (_req, res) => {
  try {
    const tactical = await icinga.getTacticalSummary();
    const aiActivity = await getAIActivitySnapshot();
    const aiMetrics = aiActivity.metrics;

    res.json({
      tactical,
      ai: aiMetrics,
      reasons: explainTacticalVsAI(tactical, aiMetrics),
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function ensureAdministratorsGroup() {
  await db.query(`
    INSERT INTO icingaweb_group ("name", "ctime", "mtime")
    SELECT 'Administrators', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM icingaweb_group WHERE lower("name") = lower('Administrators')
    )
  `);
  const r = await db.query(`SELECT id FROM icingaweb_group WHERE lower("name") = lower('Administrators') LIMIT 1`)
    .catch(() => ({ rows: [] }));
  return r.rows[0]?.id ?? null;
}

async function setContactAdmin(username, admin) {
  const groupId = await ensureAdministratorsGroup();
  if (groupId === null) return;
  if (admin) {
    await db.query(`
      INSERT INTO icingaweb_group_membership ("group_id", "username", "ctime", "mtime")
      SELECT $1::integer, $2::varchar, NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM icingaweb_group_membership
        WHERE "group_id" = $1::integer AND lower("username") = lower($2::text)
      )
    `, [groupId, username]);
  } else {
    await db.query(
      `DELETE FROM icingaweb_group_membership WHERE "group_id" = $1::integer AND lower("username") = lower($2::text)`,
      [groupId, username]
    );
  }
}

// Contacts — usuários operacionais compartilhados com IcingaWeb2
app.get(`${BASE}/contacts`, requireAuth, apiLimiter, async (_req, res) => {
  try {
    let r = await db.query(`
      SELECT u.name, u.active, u.ctime, u.mtime,
             EXISTS (
               SELECT 1
               FROM icingaweb_group_membership gm
               JOIN icingaweb_group g ON g.id = gm.group_id
               WHERE lower(g.name) = lower('Administrators')
                 AND lower(gm.username) = lower(u.name)
             ) AS admin
      FROM icingaweb_user u
      ORDER BY lower(u.name)
      LIMIT 200
    `).catch(async () => db.query(`
      SELECT u.name, u.active, u.ctime, u.mtime,
             EXISTS (
               SELECT 1
               FROM icingaweb_group_membership gm
               WHERE lower(gm.group_name) = lower('Administrators')
                 AND lower(gm.username) = lower(u.name)
             ) AS admin
      FROM icingaweb_user u
      ORDER BY lower(u.name)
      LIMIT 200
    `));
    res.json({ contacts: r.rows, total: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${BASE}/contacts`, requireAuth, requireAdmin, requireAdminWrite, async (req, res) => {
  const { name, password, active, admin } = req.body || {};
  const username = String(name || '').trim();
  if (!/^[a-zA-Z0-9_.@-]{2,128}$/.test(username)) {
    return res.status(400).json({ error: 'name inválido' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'password deve ter pelo menos 8 caracteres' });
  }
  try {
    const exists = await db.query(
      `SELECT 1 FROM icingaweb_user WHERE lower("name") = lower($1::text) LIMIT 1`,
      [username]
    );
    if (exists.rowCount) return res.status(409).json({ error: 'contato já existe' });
    await db.query(`
      INSERT INTO icingaweb_user ("name", "active", "password_hash", "ctime", "mtime")
      VALUES ($1::varchar, $2::smallint, convert_to(crypt($3::text, gen_salt('bf', 12)), 'UTF8'), NOW(), NOW())
    `, [username, active === false ? 0 : 1, String(password)]);
    await setContactAdmin(username, admin === true);
    res.status(201).json({ contact: { name: username, active: active === false ? 0 : 1, admin: admin === true } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch(`${BASE}/contacts/:name`, requireAuth, requireAdmin, requireAdminWrite, async (req, res) => {
  const username = String(req.params.name || '').trim();
  const { password, active, admin } = req.body || {};
  try {
    const updates = [];
    const vals = [];
    let i = 1;
    if (active !== undefined) { updates.push(`"active" = $${i++}::smallint`); vals.push(active === false ? 0 : 1); }
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: 'password deve ter pelo menos 8 caracteres' });
      updates.push(`"password_hash" = convert_to(crypt($${i++}::text, gen_salt('bf', 12)), 'UTF8')`);
      vals.push(String(password));
    }
    if (updates.length) {
      updates.push('"mtime" = NOW()');
      vals.push(username);
      const r = await db.query(
        `UPDATE icingaweb_user SET ${updates.join(', ')} WHERE lower("name") = lower($${i}::text) RETURNING "name", "active", "mtime"`,
        vals
      );
      if (!r.rowCount) return res.status(404).json({ error: 'contato não encontrado' });
    } else {
      const exists = await db.query(`SELECT 1 FROM icingaweb_user WHERE lower("name") = lower($1::text) LIMIT 1`, [username]);
      if (!exists.rowCount) return res.status(404).json({ error: 'contato não encontrado' });
    }
    if (admin !== undefined) await setContactAdmin(username, admin === true);
    res.json({ updated: true, name: username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hosts — listagem
app.get(`${BASE}/hosts`, requireAuth, apiLimiter, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM observe_hosts ORDER BY updated_at DESC LIMIT 200');
    res.json({ hosts: r.rows, total: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hosts — host individual
app.get(`${BASE}/hosts/:name`, requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM observe_hosts WHERE name = $1', [req.params.name]);
    if (!r.rowCount) return res.status(404).json({ error: 'Host não encontrado' });
    res.json({ host: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hosts — criação/upsert manual (registra em DB + Icinga2)
app.post(`${BASE}/hosts`, requireAuth, requireAdmin, requireInventoryWrite, async (req, res) => {
  const { name, address, display_name, vars } = req.body;
  if (!name || !address) return res.status(400).json({ error: '"name" e "address" são obrigatórios' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
    return res.status(400).json({ error: 'name inválido (use apenas letras, números, hífens, pontos)' });
  try {
    // Upsert no banco
    const r = await db.query(
      `INSERT INTO observe_hosts (id, name, address, metadata, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET address = EXCLUDED.address, metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [crypto.randomUUID(), name, address, JSON.stringify({ source: 'manual', display_name, vars })]
    );
    // Sincroniza com Icinga2 (não-fatal: falha no Icinga não impede resposta)
    let icingaResult = { ok: false, existed: false, error: 'unreachable' };
    try {
      icingaResult = await icinga.registerHost(name, address, display_name || name, vars || {});
    } catch (e) {
      icingaResult.error = e.message;
    }
    log('info', 'Host registered', { name, address, icinga_ok: icingaResult.ok });
    res.status(201).json({ host: r.rows[0], icinga: { ok: icingaResult.ok, existed: icingaResult.existed, error: icingaResult.error } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inventory — Docker local agent bulk upsert
app.post(`${BASE}/inventory/docker`, requireAuth, requireAdmin, requireInventoryWrite, validateBody(bodySchemas.dockerInventory), async (req, res) => {
  const { agent_id, host, address, containers } = req.body || {};
  const hostName = host || agent_id;
  if (!hostName) return res.status(400).json({ error: '"agent_id" ou "host" é obrigatório' });
  if (!Array.isArray(containers)) return res.status(400).json({ error: '"containers" deve ser array' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(hostName))
    return res.status(400).json({ error: 'host inválido (use apenas letras, números, hífens, pontos)' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const hostResult = await client.query(
      `INSERT INTO observe_hosts (id, name, address, status, last_check, metadata, updated_at)
       VALUES ($1, $2, $3, 'up', NOW(), $4, NOW())
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET address = EXCLUDED.address,
                     status = 'up',
                     last_check = NOW(),
                     metadata = EXCLUDED.metadata,
                     updated_at = NOW()
       RETURNING id`,
      [crypto.randomUUID(), hostName, address || null, JSON.stringify({
        source: 'docker-agent',
        agent_id: agent_id || hostName,
        container_count: containers.length,
      })]
    );
    const hostId = hostResult.rows[0].id;

    let upserted = 0;
    for (const c of containers) {
      if (!c || !c.name) continue;
      const status = c.ignored
        ? 'up'
        : c.health === 'unhealthy'
        ? 'critical'
        : (c.state === 'running' ? 'up' : 'warning');
      await client.query(
        `INSERT INTO observe_services (id, host_id, name, status, last_check, output, metadata, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6, NOW())
         ON CONFLICT (tenant_id, host_id, name)
         DO UPDATE SET status = EXCLUDED.status,
                       last_check = NOW(),
                       output = EXCLUDED.output,
                       metadata = EXCLUDED.metadata,
                       updated_at = NOW()`,
        [
          crypto.randomUUID(),
          hostId,
          c.name,
          status,
          c.status || c.state || '',
          JSON.stringify({
            source: 'docker-agent',
            container_id: c.id,
            image: c.image,
            state: c.state,
            status: c.status,
            health: c.health,
            ignored: !!c.ignored,
            compose_project: c.compose_project,
            compose_service: c.compose_service,
            ports: c.ports || [],
            networks: c.networks || {},
          }),
        ]
      );
      upserted++;
    }

    await client.query('COMMIT');
    log('info', 'Docker inventory synced', { host: hostName, services: upserted });
    res.status(202).json({ accepted: true, host: hostName, services: upserted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Hosts — remoção (remove de DB + Icinga2)
app.delete(`${BASE}/hosts/:name`, requireAuth, requireAdmin, requireInventoryWrite, async (req, res) => {
  const { name } = req.params;
  try {
    const r = await db.query('DELETE FROM observe_hosts WHERE name = $1 RETURNING id', [name]);
    if (!r.rowCount) return res.status(404).json({ error: 'Host não encontrado' });
    let icingaResult = { ok: false, error: 'unreachable' };
    try {
      icingaResult = await icinga.removeHost(name);
    } catch (e) {
      icingaResult.error = e.message;
    }
    log('info', 'Host removed', { name, icinga_ok: icingaResult.ok });
    res.json({ removed: true, name, icinga: { ok: icingaResult.ok, error: icingaResult.error } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hosts — dispara scan de rede (enfileira para o agente/script externo processar)
app.post(`${BASE}/hosts/scan`, requireAuth, requireAdmin, requireInventoryWrite, async (req, res) => {
  const { subnet } = req.body;
  const task = JSON.stringify({ type: 'scan:requested', subnet: subnet || null, requested_at: new Date().toISOString() });
  try {
    if (redis) await redis.rpush('observe:scan:network', task);
    log('info', 'Network scan requested', { subnet: subnet || 'auto' });
    res.status(202).json({
      accepted: true,
      subnet:   subnet || 'auto-detect',
      message:  'Scan enfileirado. Execute: npm run observe:discover -- --mode r-observe' + (subnet ? ` --subnet ${subnet}` : ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Discovery data proxy (evita token interno na UI) ──────────────────────
// As rotas /observe/discovery/* sao roteadas pelo Nginx para ca.
// O API proxy injeta o token interno e repassa para o discovery.
// Sem sessao → redirect para /observe/login.

app.get('/observe/assets/:id', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, db, SESSION_COOKIE);
    if (!auth) return res.redirect(`/observe/login?next=${encodeURIComponent('/observe/assets/'+req.params.id)}`);
    req.auth = auth;
  } catch (_) {
    return res.redirect(`/observe/login?next=${encodeURIComponent('/observe/assets/'+req.params.id)}`);
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(ASSET_DETAIL_HTML.replace('__ASSET_ID__', req.params.id));
});

app.get('/observe/discovery', async (req, res) => {
  // Verifica sessao manualmente e redireciona para login se ausente
  try {
    const auth = await authenticateRequest(req, db, SESSION_COOKIE);
    if (!auth) return res.redirect(`/observe/login?next=${encodeURIComponent('/observe/discovery')}`);
    req.auth = auth;
  } catch (_) {
    return res.redirect(`/observe/login?next=${encodeURIComponent('/observe/discovery')}`);
  }
  const out = await proxyToDiscovery('/observe/discovery');
  res.set('Content-Type', out.headers?.['content-type'] || 'text/html; charset=utf-8');
  res.status(out.status).send(out.raw || out.data);
});

app.get('/observe/api/data/summary', requireAuth, async (req, res) => {
  const q = discoveryQuery(req);
  const out = await proxyToDiscovery(`/observe/discovery/data/summary${q}`);
  res.status(out.status).json(out.data);
});

app.get('/observe/api/data/scopes', requireAuth, async (req, res) => {
  const out = await proxyToDiscovery('/observe/discovery/data/scopes');
  res.status(out.status).json(out.data);
});

// Discovery compatibility endpoints
function discoveryQuery(req) {
  const p = new URLSearchParams();
  if (req.query.tenant_id) p.set('tenant_id', String(req.query.tenant_id));
  if (req.query.site_id) p.set('site_id', String(req.query.site_id));
  if (req.query.edge_id) p.set('edge_id', String(req.query.edge_id));
  if (req.query.run_id) p.set('run_id', String(req.query.run_id));
  if (req.query.asset_id) p.set('asset_id', String(req.query.asset_id));
  // Pagination params (Enterprise)
  if (req.query.limit) p.set('limit', String(req.query.limit));
  if (req.query.after) p.set('after', String(req.query.after));
  if (req.query.before) p.set('before', String(req.query.before));
  if (req.query.sort) p.set('sort', String(req.query.sort));
  // Audit filters
  if (req.query.action) p.set('action', String(req.query.action));
  if (req.query.actor) p.set('actor', String(req.query.actor));
  if (req.query.resource_type) p.set('resource_type', String(req.query.resource_type));
  if (req.query.resource_id) p.set('resource_id', String(req.query.resource_id));
  const q = p.toString();
  return q ? `?${q}` : '';
}

app.get(`${BASE}/discovery/runs`, requireAuth, async (_req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/runs${discoveryQuery(_req)}`);
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/assets`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/assets${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/findings`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/findings${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/topology`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/topology${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/fingerprints`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/fingerprints${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/policies`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/policies${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

app.post(`${BASE}/discovery/policies`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery('/api/discovery/policies', { method: 'POST', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});

app.post(`${BASE}/discovery/scan`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery('/api/discovery/scan', { method: 'POST', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/history`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/history${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/progress`, requireAuth, async (_req, res) => {
  const out = await proxyToDiscovery('/api/discovery/progress');
  res.status(out.status).json(out.data);
});

// Policies — PATCH e DELETE
app.patch(`${BASE}/discovery/policies/:id`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/policies/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.delete(`${BASE}/discovery/policies/:id`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/policies/${req.params.id}`, { method: 'DELETE' });
  res.status(out.status).json(out.data);
});

// Targets — CRUD completo
app.get(`${BASE}/discovery/targets`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/targets${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});
app.post(`${BASE}/discovery/targets`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery('/api/discovery/targets', { method: 'POST', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.patch(`${BASE}/discovery/targets/:id`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/targets/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.delete(`${BASE}/discovery/targets/:id`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/targets/${req.params.id}`, { method: 'DELETE' });
  res.status(out.status).json(out.data);
});

// Assets — atualizar ciclo de vida
app.patch(`${BASE}/discovery/assets/:id`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/assets/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});

// ── Enterprise: Schedules, Quotas, Audit ────────────────────────────────────
app.get(`${BASE}/discovery/schedules`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/schedules${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});
app.post(`${BASE}/discovery/schedules`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery('/api/discovery/schedules', { method: 'POST', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.patch(`${BASE}/discovery/schedules/:id`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/schedules/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.delete(`${BASE}/discovery/schedules/:id`, requireAuth, requireAdmin, requireDiscoveryWrite, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/schedules/${req.params.id}`, { method: 'DELETE' });
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/quotas`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/quotas${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

app.get(`${BASE}/discovery/audit`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/audit${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

// ── Remote Agents ──────────────────────────────────────────────────────────
app.get(`${BASE}/discovery/agents`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/agents${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});

// Hosts — lista hosts do Icinga2 diretamente
app.get(`${BASE}/hosts/icinga/list`, requireAuth, async (_req, res) => {
  try {
    const hosts = await icinga.listHosts();
    res.json({ hosts, total: hosts.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Services
app.get(`${BASE}/services`, requireAuth, apiLimiter, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM observe_services ORDER BY updated_at DESC LIMIT 200');
    res.json({ services: r.rows, total: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Incidents
app.get(`${BASE}/incidents`, requireAuth, apiLimiter, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM observe_incidents ORDER BY created_at DESC LIMIT 50');
    res.json({ incidents: r.rows, total: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get(`${BASE}/incidents/:id`, requireAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM observe_incidents WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    const incident = r.rows[0];
    const events = await db.query(
      'SELECT * FROM observe_incident_events WHERE incident_id = $1 ORDER BY occurred_at ASC',
      [req.params.id]
    );
    res.json({ incident, timeline: events.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Events (generic)
app.post(`${BASE}/events`, requireAuth, requireScopeForJwt('api:events:write'), eventLimiter, validateBody(bodySchemas.event), async (req, res) => {
  const event = req.body;
  if (!event || !event.type) return res.status(400).json({ error: 'event.type is required' });
  try {
    eventsReceivedTotal.inc({ source: event.source || 'generic' });
    if (redis) await redis.rpush('observe:events', JSON.stringify({ ...event, receivedAt: new Date().toISOString() }));
    res.status(202).json({ accepted: true, id: crypto.randomUUID() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Icinga events
app.post(`${BASE}/icinga/events`, requireAuth, requireScopeForJwt('api:events:write'), eventLimiter, validateBody(bodySchemas.icingaEvent), async (req, res) => {
  const event = req.body;
  if (!event) return res.status(400).json({ error: 'Body obrigatório' });
  try {
    eventsReceivedTotal.inc({ source: 'icinga' });
    const payload = JSON.stringify({ ...event, source: 'icinga', receivedAt: new Date().toISOString() });
    if (redis) await redis.rpush('observe:events:icinga', payload);
    res.status(202).json({ accepted: true, id: crypto.randomUUID() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI explain (proxy para observe-ai)
app.post(`${BASE}/ai/explain`, requireAuth, async (req, res) => {
  if (process.env.AI_ENABLED !== 'true') {
    return res.status(503).json({ error: 'AI service disabled' });
  }
  const { incident, context } = req.body;
  if (!incident) return res.status(400).json({ error: 'incident é obrigatório' });
  const result = await proxyToAI('/ai/explain', { method: 'POST', body: JSON.stringify({ incident, context }) });
  res.status(result.status).json(result.data);
});

// AI models — lista modelos do provider (real ou fallback estático)
app.get(`${BASE}/ai/models`, requireAuth, async (req, res) => {
  const provider = String(req.query.provider || 'openai').toLowerCase();
  if (!VALID_AI_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'provider inválido' });
  }
  const qs = `?provider=${encodeURIComponent(provider)}`;
  const result = await proxyToAI(`/ai/models${qs}`);
  if (result.ok && result.status < 400) {
    return res.status(result.status).json(result.data);
  }
  // fallback: AI service indisponível ou retornou erro
  const aiReason = (result.data && result.data.reason) || 'ai_service_unavailable';
  res.json({
    provider,
    models: AI_STATIC_MODELS[provider] || [],
    auto: AI_AUTO_MODELS[provider] || null,
    source: 'static',
    reason: aiReason,
    degraded: true,
    ai_status: result.status,
  });
});


// ── Asset Detail HTML ────────────────────────────────────────────────────
const ASSET_DETAIL_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>R-Observe · Ativo</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6;--green:#22c55e;--red:#ef4444;--yellow:#eab308}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.topbar{display:flex;align-items:center;gap:1rem;padding:.75rem 1.5rem;background:var(--surface);border-bottom:1px solid var(--border)}
.topbar img{height:28px}
.topbar-title{font-size:.85rem;color:var(--muted)}
.topbar a{color:var(--accent);text-decoration:none;font-size:.85rem}
.topbar a:hover{text-decoration:underline}
.topbar button{color:var(--accent);background:transparent;border:0;font:inherit;font-size:.85rem;cursor:pointer}
.topbar button:hover{text-decoration:underline}
.topbar a:focus-visible,.topbar button:focus-visible,.meta-toggle:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.container{max-width:1100px;margin:0 auto;padding:1.5rem}
.back-link{display:inline-block;margin-bottom:1rem;color:var(--accent);text-decoration:none;font-size:.875rem}
h1{font-size:1.5rem;margin-bottom:.25rem}
.subtitle{color:var(--muted);margin-bottom:1.5rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.25rem}
.card-title{font-size:.8rem;text-transform:uppercase;color:var(--muted);margin-bottom:1rem;letter-spacing:.05em}
.info-row{display:flex;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border);font-size:.875rem}
.info-row:last-child{border-bottom:none}
.info-label{color:var(--muted)}
.info-value{font-weight:600;text-align:right}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.75rem;font-weight:600}
.badge-approved{background:#166534;color:#86efac}
.badge-monitored{background:#1e40af;color:#93c5fd}
.badge-discovered{background:#713f12;color:#fde047}
.badge-ignored{background:#334155;color:#94a3b8}
.badge-quarantined{background:#7f1d1d;color:#fca5a5}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:var(--muted);font-weight:600;padding:.5rem;border-bottom:2px solid var(--border)}
td{padding:.5rem;border-bottom:1px solid var(--border)}
.status-open{color:var(--green)}
.status-closed{color:var(--red)}
.status-filtered{color:var(--yellow)}
.meta-json{font-size:.75rem;background:#0f172a;padding:.75rem;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:var(--muted);max-height:300px;overflow-y:auto}
.meta-toggle{cursor:pointer}
.loading{text-align:center;padding:3rem;color:var(--muted)}
.error{text-align:center;padding:3rem;color:var(--red)}
</style>
</head>
<body>
<div class="topbar">
  <a href="/observe/home"><img src="/observe/api/ui/logo.svg" onerror="this.style.display='none'" alt="R"/></a>
  <span class="topbar-title">Results · Sistemas de Informática / R-Observe</span>
  <span style="flex:1"></span>
  <a href="/observe/home">⌂ Home</a>
  <a href="/observe/discovery">🔍 Discovery</a>
  <a href="/observe/versions">ⓘ Versões</a>
  <a href="/observe/settings">⚙ Configuração</a>
  <button type="button" onclick="logout()">Sair</button>
</div>
<div class="container">
  <a href="/observe/discovery" class="back-link">← Voltar para Discovery</a>
  <div id="content"><div class="loading">Carregando...</div></div>
</div>
<script>
const ASSET_ID = '__ASSET_ID__';
function toggleMeta(card){ var id = card.getAttribute("data-meta"); if (!id) return; var content = document.getElementById('mc-'+id); var title = card.querySelector('.card-title'); if (!content || !title) return; var isOpen = content.style.display !== 'none'; card.setAttribute('aria-expanded',String(!isOpen)); if (isOpen) { content.style.display = 'none'; title.textContent = title.textContent.replace(' ▾',' ▸'); return; } content.style.display = 'block'; title.textContent = title.textContent.replace(' ▸',' ▾'); if (content.dataset.loaded) return; content.dataset.loaded = '1'; var m = window._assetMeta || {}; var r = window._r || function(l,v){ return '<div class="info-row"><span class="info-label">'+l+'</span><span class="info-value">'+v+'</span></div>'; }; var hh = ''; if (id === 'scan') { var s = m.scan || {}; if (s.open_ports && s.open_ports.length) hh+=r('Portas abertas', s.open_ports.length); if (s.hostname) hh+=r('Hostname', s.hostname); if (s.ssh_banner) hh+=r('SSH Banner', s.ssh_banner); if (s.http_server) hh+=r('HTTP Server', s.http_server); if (s.http_title) hh+=r('HTTP Title', s.http_title); if (s.smtp_banner) hh+=r('SMTP Banner', s.smtp_banner); if (s.tls_subject) hh+=r('TLS Subject', s.tls_subject); if (s.tls_issuer) hh+=r('TLS Issuer', s.tls_issuer); if (s.tls_valid_from && s.tls_valid_to) hh+=r('TLS Validade', s.tls_valid_from+' → '+s.tls_valid_to); if (s.favicon_hash) hh+=r('Favicon Hash', s.favicon_hash); if (s.protocols_detected) { var p=Object.entries(s.protocols_detected).filter(function(e){return e[1];}).map(function(e){return e[0];}).join(', '); if(p) hh+=r('Protocolos', p); } if (!hh) hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum dado de scan.</p>'; } else if (id === 'inference') { var i = m.inference || {}; if (i.vendor) hh+=r('Fabricante inferido', i.vendor); if (i.product) hh+=r('Produto inferido', i.product); if (i.service) hh+=r('Serviço inferido', i.service); if (i.category) hh+=r('Categoria', i.category); if (i.evidence) hh+=r('Evidências', i.evidence.length); if (!hh) hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum dado de inferência.</p>'; } else if (id === 'snmp') { var sn = m.snmp || {}; if (sn.sysDescr) hh+=r('sysDescr', sn.sysDescr); if (sn.sysName) hh+=r('sysName', sn.sysName); if (sn.sysUptime) hh+=r('sysUptime', sn.sysUptime); if (sn.sysObjectID) hh+=r('sysObjectID', sn.sysObjectID); if (sn.sysLocation) hh+=r('sysLocation', sn.sysLocation); if (sn.sysContact) hh+=r('sysContact', sn.sysContact); if (sn.interfaces && sn.interfaces.length) hh+=r('Interfaces SNMP', sn.interfaces.length+' detectadas'); if (!hh) hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum dado SNMP.</p>'; } else if (id === 'banners') { var b = (m.scan && m.scan.port_banners) ? m.scan.port_banners : {}; var keys = Object.keys(b); if (keys.length > 0) { hh+='<table><thead><tr><th>Porta</th><th>Banner</th></tr></thead><tbody>'; keys.slice(0,10).forEach(function(k){ hh+='<tr><td><strong>'+k+'</strong></td><td style="font-size:.75rem;max-width:400px;word-break:break-all">'+(b[k]||'—')+'</td></tr>'; }); hh+='</tbody></table>'; } else hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum banner detectado.</p>'; } else if (id === 'json') { hh = JSON.stringify(m, null, 2); } content.innerHTML = hh; }
function metaKey(event,card){if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleMeta(card);}}
function logout(){var cookie=document.cookie.split('; ').find(function(value){return value.split('=')[0].endsWith('_csrf');});var token=cookie?decodeURIComponent(cookie.split('=').slice(1).join('=')):'';fetch('/observe/api/auth/logout',{method:'POST',headers:{'x-csrf-token':token}}).finally(function(){location.href='/observe/login';});}
function load(){
  fetch('/observe/api/assets/'+ASSET_ID,{headers:{'Accept':'application/json'}})
    .then(r=>r.ok?r.json():Promise.reject('HTTP '+r.status))
    .then(d=>render(d.asset,d.services,d.incidents||[],d.changes||[],d.interfaces||[]))
    .catch(e=>document.getElementById('content').innerHTML='<div class="error">'+e+'</div>');
}
function badge(s){
  const m={approved:'approved',monitored:'monitored',discovered:'discovered',ignored:'ignored',quarantined:'quarantined'};
  return '<span class="badge badge-'+(m[s]||'ignored')+'">'+(s||'?')+'</span>';
}
function render(a,svc,inc,chg,ifaces){
  const m=a.metadata||{};
  const sysD=m.sysDescr||m.snmp_sysDescr||'';
  const os=a.os_hint||m.os||m.snmp_os||'—';
  const v=a.vendor||m.vendor||'—';
  const p=a.product||m.product||'—';
  const up=m.snmp_sysUpTime||m.sysUptime||'—';
  const dns=a.hostname||m.dns_reverse||m.hostname||'—';
  const ip=a.primary_ip||m.ip||'—';
  const fs=a.first_seen_at?new Date(a.first_seen_at).toLocaleString('pt-BR'):'—';
  const ls=a.last_seen_at?new Date(a.last_seen_at).toLocaleString('pt-BR'):'—';
  let h='';
  h+='<h1>'+(a.display_name||a.asset_name||'Ativo')+'</h1>';
  h+='<div class="subtitle">'+a.asset_type+' · '+os+' · '+badge(a.lifecycle_state)+'</div>';
  h+='<div class="grid">';
  h+='<div class="card"><div class="card-title">Sistema</div>';
  h+=r('Nome',a.asset_name);h+=r('Display Name',a.display_name||'—');h+=r('IP',ip);
  h+=r('DNS Reverso',dns);h+=r('Tipo',a.asset_type);h+=r('Fabricante',v);h+=r('Produto',p);
  h+=r('Sistema Operacional',os);h+=r('Confiança',(a.confidence*100).toFixed(0)+'%');
  if(sysD)h+=r('sysDescr',sysD);
  h+='</div>';
  h+='<div class="card"><div class="card-title">Status</div>';
  h+=r('Estado',badge(a.lifecycle_state));h+=r('Criticalidade',a.criticality);
  h+=r('Primeira vez visto',fs);h+=r('Última vez visto',ls);
  if(up!=='—')h+=r('Uptime SNMP',up);
  h+='</div></div>';h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Serviços ('+svc.length+')</div>';
  // Incidents / AI
  if(inc.length>0){
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Incidentes & IA ('+inc.length+')</div>';
    h+='<table><thead><tr><th>Incidente</th><th>Gravidade</th><th>Status</th><th>Resumo IA</th></tr></thead><tbody>';
    inc.forEach(i=>{
      const sevMap={critical:'🔴',warning:'🟡',info:'🔵',error:'🔴'};
      const sev=sevMap[i.severity]||'⚪';
      h+='<tr><td><strong>'+i.title+'</strong></td><td>'+sev+' '+i.severity+'</td><td>'+i.status+'</td><td style="font-size:.8rem">'+(i.ai_summary||'—')+'</td></tr>';
      if(i.ai_suggestion) h+='<tr><td colspan="4" style="font-size:.75rem;color:var(--accent)">💡 '+i.ai_suggestion+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }
  // Asset Changes
  if(chg.length>0){
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Histórico de Alterações ('+chg.length+')</div>';
    h+='<table><thead><tr><th>Tipo</th><th>Campo</th><th>De</th><th>Para</th><th>Data</th></tr></thead><tbody>';
    chg.slice(0,15).forEach(c=>{
      h+='<tr><td>'+c.change_type+'</td><td>'+(c.field_name||'—')+'</td><td style="font-size:.75rem">'+(c.old_value||'—')+'</td><td style="font-size:.75rem">'+(c.new_value||'—')+'</td><td style="font-size:.7rem">'+new Date(c.changed_at).toLocaleString('pt-BR')+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }
  // Interfaces
  if(ifaces.length>0){
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Interfaces de Rede ('+ifaces.length+')</div>';
    h+='<table><thead><tr><th>Interface</th><th>Tipo</th><th>MAC</th><th>IPs</th><th>Velocidade</th><th>Status</th></tr></thead><tbody>';
    ifaces.forEach(ifc=>{
      h+='<tr><td><strong>'+ifc.iface_name+'</strong></td><td>'+(ifc.iface_type||'ethernet')+'</td><td style="font-size:.75rem">'+(ifc.mac_address||'—')+'</td><td style="font-size:.75rem">'+(ifc.ip_addresses||'—')+'</td><td>'+(ifc.speed_mbps||'—')+'</td><td>'+(ifc.status||'—')+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }
  if(svc.length>0){
    h+='<table><thead><tr><th>Serviço</th><th>Proto</th><th>Porta</th><th>Status</th><th>Banner</th><th>Último scan</th></tr></thead><tbody>';
    svc.forEach(s=>{
      const b=s.banner?s.banner.substring(0,120):(s.fingerprint&&s.fingerprint.banner)?s.fingerprint.banner.substring(0,120):'—';
      const lss=s.last_seen_at?new Date(s.last_seen_at).toLocaleString('pt-BR'):'—';
      h+='<tr><td><strong>'+(s.display_name||s.service_name||'?')+'</strong></td><td>'+(s.protocol||'tcp')+'</td><td>'+s.port+'</td><td class="status-'+s.status+'">'+s.status+'</td><td style="font-size:.75rem;max-width:300px;overflow:hidden;text-overflow:ellipsis">'+b+'</td><td style="font-size:.75rem">'+lss+'</td></tr>';
    });
    h+='</tbody></table>';
  }else{h+='<p style="color:var(--muted);padding:1rem">Nenhum serviço detectado.</p>';}
  h+='</div>';
// Lazy metadata sections - collapsed by default, render on click
  h+='<div class="card meta-toggle" style="margin-top:1.5rem" role="button" tabindex="0" aria-expanded="false" aria-controls="mc-scan" onclick="toggleMeta(this)" onkeydown="metaKey(event,this)" data-meta="scan"><div class="card-title">🔍 Scan ▸</div><div class="meta-content" id="mc-scan" style="display:none"></div></div>';
  h+='<div class="card meta-toggle" style="margin-top:.5rem" role="button" tabindex="0" aria-expanded="false" aria-controls="mc-inference" onclick="toggleMeta(this)" onkeydown="metaKey(event,this)" data-meta="inference"><div class="card-title">🧠 Inferência ▸</div><div class="meta-content" id="mc-inference" style="display:none"></div></div>';
  h+='<div class="card meta-toggle" style="margin-top:.5rem" role="button" tabindex="0" aria-expanded="false" aria-controls="mc-snmp" onclick="toggleMeta(this)" onkeydown="metaKey(event,this)" data-meta="snmp"><div class="card-title">📡 SNMP ▸</div><div class="meta-content" id="mc-snmp" style="display:none"></div></div>';
  if (m.scan && m.scan.port_banners) h+='<div class="card meta-toggle" style="margin-top:.5rem" role="button" tabindex="0" aria-expanded="false" aria-controls="mc-banners" onclick="toggleMeta(this)" onkeydown="metaKey(event,this)" data-meta="banners"><div class="card-title">🏷 Banners de Porta ▸</div><div class="meta-content" id="mc-banners" style="display:none"></div></div>';
  h+='<div class="card meta-toggle" style="margin-top:.5rem" role="button" tabindex="0" aria-expanded="false" aria-controls="mc-json" onclick="toggleMeta(this)" onkeydown="metaKey(event,this)" data-meta="json"><div class="card-title">📋 JSON Completo ▸</div><pre class="meta-json" id="mc-json" style="display:none"></pre></div>';
  window._assetMeta = m;
  window._r = r;
  document.getElementById('content').innerHTML=h;
}
function r(l,v){return '<div class="info-row"><span class="info-label">'+l+'</span><span class="info-value">'+v+'</span></div>';}
load();
</script>
</body>
</html>`;
// ── Sistema de Configuração Abrangente (todos os parâmetros visíveis) ──────

const SYSTEM_SETTINGS_DEFAULTS = {
  discovery: {
    scan_interval_minutes: parseInt(process.env.DISCOVERY_SCAN_INTERVAL_MINUTES || '60', 10),
    arp_enabled: process.env.DISCOVERY_ARP_ENABLED !== 'false',
    docker_enabled: process.env.DISCOVERY_DOCKER_ENABLED === 'true',
    cloud_enabled: process.env.DISCOVERY_CLOUD_AWS_ENABLED === 'true',
    passive_enabled: process.env.DISCOVERY_PASSIVE_LISTENERS_ENABLED !== 'false',
    port_change_detection: process.env.DISCOVERY_PORT_CHANGE_DETECTION !== 'false',
    port_disappeared_grace_scans: parseInt(process.env.DISCOVERY_PORT_DISAPPEARED_GRACE || '2', 10),
    scan_parallel: parseInt(process.env.DISCOVERY_SCAN_PARALLEL || '20', 10),
    extra_ports: (process.env.DISCOVERY_EXTRA_PORTS || ''),
  },
  agents: {
    offline_threshold_minutes: Math.round(parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10) / 60000),
    offline_check_enabled: process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false',
    check_interval_seconds: parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10) / 1000,
    disk_warn_percent: parseInt(process.env.DISK_WARN_PERCENT || '80', 10),
    docker_projects: (process.env.OBSERVE_DOCKER_PROJECTS || ''),
    docker_ignore_containers: (process.env.OBSERVE_DOCKER_IGNORE_CONTAINERS || ''),
  },
  certs: {
    expiry_warning_days: 30,
    expiry_critical_days: 7,
  },
  os_defaults: {
    linux_node_exporter: true,
    windows_exporter: true,
    network_snmp: true,
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'mock',
    model: process.env.AI_MODEL || 'auto',
    auto_threshold: parseFloat(process.env.REMEDIATION_AUTO_THRESHOLD || '0.85'),
    max_auto_severity: process.env.REMEDIATION_MAX_AUTO_SEVERITY || 'warning',
  },
  monitoring: {
    icinga_sync_enabled: true,
    prometheus_sd_enabled: true,
  },
};

const { createSystemSettingsService } = require('./services/system-settings');
const systemSettings = createSystemSettingsService({ db, defaults: SYSTEM_SETTINGS_DEFAULTS });

app.get(`${BASE}/system/settings`, requireAuth, async (_req, res, next) => {
  try {
    const settings = await systemSettings.load();
  res.json({
    ...settings,
    _meta: {
      ai_provider_active: settings.ai.provider,
      discovery_port_change_active: settings.discovery.port_change_detection,
      agent_offline_active: settings.agents.offline_check_enabled,
      cert_expiry_warning_days: settings.certs.expiry_warning_days,
    },
  });
  } catch (e) { next(e); }
});

app.post(`${BASE}/system/settings`, requireAuth, requireAdmin, requireAdminWrite, async (req, res, next) => {
  const body = req.body || {};
  try {
    const settings = await systemSettings.update(body);
    log('info', 'System settings updated', { changed: Object.keys(body) });
    res.json({ ok: true, settings });
  } catch (e) { next(e); }
});

// Endpoint de status ao vivo para feedback na UI
app.get(`${BASE}/system/status`, requireAuth, async (_req, res) => {
  try {
    const [aiStatus, agentStatus, discoveryStatus] = await Promise.allSettled([
      fetch(`${OBSERVE_PROXY_ORIGIN}/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null),
      (async () => {
        const db = createDbClient(process.env);
        const r = await db.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='online') as online FROM observe_discovery_agents");
        await db.end();
        return { total: parseInt(r.rows[0]?.total || 0), online: parseInt(r.rows[0]?.online || 0), offline: parseInt(r.rows[0]?.total || 0) - parseInt(r.rows[0]?.online || 0) };
      })().catch(() => ({ total: 0, online: 0, offline: 0 })),
      (async () => {
        const db = createDbClient(process.env);
        const r = await db.query("SELECT COUNT(*) as total FROM observe_assets WHERE lifecycle_state IN ('approved','monitored')");
        await db.end();
        return { total_assets: parseInt(r.rows[0]?.total || 0) };
      })().catch(() => ({ total_assets: 0 })),
    ]);

    res.json({
      ai: aiStatus.status === 'fulfilled' ? aiStatus.value : { status: 'unknown' },
      agents: agentStatus.status === 'fulfilled' ? agentStatus.value : { total: 0, online: 0, offline: 0 },
      discovery: discoveryStatus.status === 'fulfilled' ? discoveryStatus.value : { total_assets: 0 },
      whatsapp: await (async () => {
        const wa = await whatsappSettings.get().catch(() => null);
        if (!wa) return null;
        if (wa.enabled && wa.token_set) {
          const raw = await whatsappSettings.getRaw().catch(() => null);
          if (raw && raw.access_token) {
            const v = await validateAccessToken({ accessToken: raw.access_token, timeoutMs: 6000 }).catch(() => null);
            wa.token_status = v && v.valid ? 'ok' : 'invalid';
          }
        }
        return wa;
      })(),
      settings: await (async () => {
        const settings = await systemSettings.load();
        // O provider/modelo real de IA fica em observe_ai_settings (não no
        // bloco legado observe_system_settings.ai). Sobrescreve para que o
        // status "IA Provider" da UI reflita o provider realmente ativo.
        const persistedAI = await getPersistedAISettings().catch(() => null);
        if (persistedAI) {
          const keyStatus = await getProviderKeyStatus(persistedAI.provider, persistedAI.api_key).catch(() => ({ status: 'no_key' }));
          settings.ai = {
            ...(settings.ai || {}),
            provider: persistedAI.provider,
            model: persistedAI.model,
            has_api_key: !!persistedAI.api_key,
            key_status: keyStatus.status,
          };
        }
        return settings;
      })(),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─── WhatsApp (notificações) — configuração persistida no banco, via UI ──────
app.get(`${BASE}/system/whatsapp`, requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await whatsappSettings.get());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auditoria: últimas mensagens do canal (entrada e saída), mais recentes primeiro.
// Recibos (status_callback) vão no campo `receipts` e são dobrados na mensagem
// original pela UI — exceto quando filtrados explicitamente (kind=status_callback).
app.get(`${BASE}/system/whatsapp/messages`, requireAuth, requireAdmin, async (req, res) => {
  try {
    const q = { ...req.query };
    const wantsReceipts = q.kind === 'status_callback';
    if (!q.kind) q.excludeKind = 'status_callback';
    const messages = await whatsappMsgLog.listRecent(q);
    const receipts = wantsReceipts ? [] : await whatsappMsgLog.listRecent({ kind: 'status_callback', limit: 200 });
    res.json({ messages, receipts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put(`${BASE}/system/whatsapp`, requireAuth, requireAdmin, requireAdminWrite, async (req, res) => {
  try {
    const body = req.body || {};
    // Valida um token recém-informado no Graph API antes de persistir.
    const newToken = body.access_token ? String(body.access_token).trim() : '';
    const tokenValidated = !!(newToken && !/^[\u25CF*\u2022]/.test(newToken));
    if (tokenValidated) {
      const validation = await validateAccessToken({ accessToken: newToken });
      if (!validation.valid) {
        return res.status(400).json({ error: 'Token inválido: o Meta rejeitou a autenticação.' });
      }
    }
    const updated = await whatsappSettings.update(body);
    res.json({ ...updated, token_validated: tokenValidated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE}/system/whatsapp/test`, requireAuth, requireAdmin, requireAdminWrite, async (req, res) => {
  try {
    const cfg = await whatsappSettings.getRaw();
    if (!cfg || !cfg.enabled) return res.status(400).json({ error: 'WhatsApp não está habilitado.' });
    if (!cfg.access_token || !cfg.phone_number_id || !cfg.recipient) {
      return res.status(400).json({ error: 'Configuração incompleta: preencha token, Phone Number ID e destinatário.' });
    }
    const to = (req.body && req.body.recipient) || cfg.recipient;
    const text = (req.body && req.body.text) ? String(req.body.text).slice(0, 4096) : '✅ R-Observe: notificação WhatsApp configurada com sucesso.';
    let result;
    try {
      result = await sendWhatsAppMessage({
        accessToken: cfg.access_token,
        phoneNumberId: cfg.phone_number_id,
        to,
        text,
      });
    } catch (sendErr) {
      await whatsappMsgLog.record({ direction: 'out', kind: 'test_send', phone: to, body: text, status: 'failed', error: sendErr.message });
      await whatsappConnLog.record({ channel: 'cloud', event: 'send_cloud_fail', detail: `to=${to} err=${sendErr.message}` });
      throw sendErr;
    }
    await whatsappMsgLog.record({ direction: 'out', kind: 'test_send', phone: to, body: text, status: 'sent', metaMessageId: result.message_id });
    await whatsappConnLog.record({ channel: 'cloud', event: 'send_cloud_ok', detail: `to=${to} http=${result.status || '—'}` });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── WhatsApp QR (canal alternativo, não-oficial) ────────────────────────────
// A API não fala com o bridge (que roda no worker): lê o estado e escreve o
// comando (enabled/desired_state) em observe_whatsapp_qr_connections.
app.get(`${BASE}/system/whatsapp/qr/status`, requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await whatsappQr.getStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE}/system/whatsapp/qr/connect`, requireAuth, requireAdmin, requireAdminWrite, async (req, res) => {
  try {
    const status = await whatsappQr.connect();
    await whatsappConnLog.record({ channel: 'qr', event: 'connect_requested', detail: req.auth && req.auth.user ? `user=${req.auth.user}` : null });
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(`${BASE}/system/whatsapp/qr/disconnect`, requireAuth, requireAdmin, requireAdminWrite, async (req, res) => {
  try {
    const disable = !!(req.body && req.body.enabled === false);
    const status = await whatsappQr.disconnect({ enabled: req.body ? req.body.enabled : undefined });
    const user = req.auth && req.auth.user ? `user=${req.auth.user}` : null;
    await whatsappConnLog.record({ channel: 'qr', event: 'disconnect_requested', detail: [user, disable ? 'disabled=true' : null].filter(Boolean).join(' ') || null });
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Log persistente de eventos de conexão (ambos os canais): ciclo de vida do
// QR, comandos aplicados pelo worker e resultados de envio. Filtros
// whitelistados (channel/event) no helper.
app.get(`${BASE}/system/whatsapp/connections/log`, requireAuth, requireAdmin, async (req, res) => {
  try {
    const events = await whatsappConnLog.listRecent(req.query || {});
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WhatsApp Webhook (interação bidirecional) ───────────────────────────────
// Rotas públicas: a Meta chama diretamente (sem sessão). A autenticidade vem do
// verify token (GET) e da assinatura HMAC X-Hub-Signature-256 (POST).

function isValidHubSignature(rawBody, signatureHeader, appSecret) {
  if (!rawBody || !signatureHeader || !appSecret) return false;
  try {
    const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const provided = String(signatureHeader).replace(/^sha256=/i, '').trim().toLowerCase();
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function handleIncomingWhatsAppMessage({ from, text, phoneNumberId }) {
  const cfg = await whatsappSettings.getRaw();
  if (!cfg || !cfg.enabled || !cfg.access_token || !cfg.phone_number_id) return;
  const reply = await whatsappBot.handleMessage({ text });
  if (!reply) return;
  try {
    const sent = await sendWhatsAppMessage({
      accessToken: cfg.access_token,
      phoneNumberId: phoneNumberId || cfg.phone_number_id,
      to: from,
      text: reply,
    });
    await whatsappMsgLog.record({ direction: 'out', kind: 'bot_reply', phone: from, body: reply, status: 'sent', metaMessageId: sent.message_id });
  } catch (e) {
    await whatsappMsgLog.record({ direction: 'out', kind: 'bot_reply', phone: from, body: reply, status: 'failed', error: e.message });
    log('warn', 'WhatsApp reply failed', { err: e.message });
  }
}

app.get(`${BASE}/whatsapp/webhook`, async (req, res) => {
  const cfg = await whatsappSettings.getRaw();
  const verifyToken = cfg?.webhook_verify_token;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken && token === verifyToken && challenge) {
    return res.status(200).type('text/plain').send(String(challenge));
  }
  res.status(403).type('text/plain').send('forbidden');
});

app.post(`${BASE}/whatsapp/webhook`, async (req, res) => {
  const cfg = await whatsappSettings.getRaw();
  // Sempre responde 200 para a Meta encerrar a entrega; falhas são logadas.
  if (!cfg || !cfg.enabled) return res.sendStatus(200);
  if (cfg.app_secret) {
    const sig = req.headers['x-hub-signature-256'];
    if (!isValidHubSignature(req.rawBody, sig, cfg.app_secret)) {
      log('warn', 'WhatsApp webhook: assinatura inválida');
      return res.sendStatus(200);
    }
  }
  const entries = req.body?.entry || [];
  for (const entry of entries) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || cfg.phone_number_id;
      for (const msg of value.messages || []) {
        if (msg.type !== 'text') continue;
        const from = msg.from;
        const text = msg.text?.body;
        if (!from || !text) continue;
        await whatsappMsgLog.record({ direction: 'in', kind: 'webhook_in', phone: from, body: text, status: 'received' });
        handleIncomingWhatsAppMessage({ from, text, phoneNumberId })
          .catch((e) => log('warn', 'WhatsApp webhook processing failed', { err: e.message }));
      }
      // Recibos da Meta (enviada/entregue/lida/falha) — auditoria de entrega.
      for (const st of value.statuses || []) {
        if (!['sent', 'delivered', 'read', 'failed'].includes(st.status)) continue;
        const stError = st.status === 'failed' && Array.isArray(st.errors) && st.errors[0]
          ? (st.errors[0].title || st.errors[0].message || 'falha na entrega')
          : null;
        await whatsappMsgLog.record({
          direction: 'out', kind: 'status_callback', phone: st.recipient_id || null,
          body: null, status: st.status, error: stError, metaMessageId: st.id || null,
        });
      }
    }
  }
  res.sendStatus(200);
});

// ─── Versões da stack ────────────────────────────────────────────────────────
// Gerado por scripts/observe/update-stack-versions.js (npm run observe:update-versions).
// NÃO edite manualmente — rode o script após alterar versões no compose/Dockerfiles.
const STACK_VERSIONS = require('./stack-versions.json');

// Versões da stack — consumida pela página /observe/versions
app.get(`${BASE}/system/versions`, requireAuth, (_req, res) => {
  res.json({
    stack: STACK_VERSIONS.stack,
    version: STACK_VERSIONS.version,
    generated_at: new Date().toISOString(),
    groups: STACK_VERSIONS.groups,
  });
});

// ─── Asset Detail ────────────────────────────────────────────────────────
app.get(`${BASE}/assets/:id`, requireAuth, async (req, res) => {
  try {
    const pool = require('./db').createDbClient(process.env);
    const asset = await pool.query(
      `SELECT id, asset_name, display_name, asset_type, vendor, product, os_hint, 
              primary_ip, hostname, lifecycle_state, criticality, confidence,
              metadata, first_seen_at, last_seen_at, created_at, updated_at
       FROM observe_assets
       WHERE id = $1::uuid AND tenant_id = $2`,
      [req.params.id, req.auth.tenantId || 'default']
    ).catch(() => ({ rows: [] }));
    if (!asset.rows.length) { await pool.end().catch(()=>{}); return res.status(404).json({ error: 'Ativo não encontrado' }); }
    
    const [services, incidents, changes, interfaces] = await Promise.all([
      pool.query(
        `SELECT service_name, protocol, port, status, fingerprint, first_seen_at, last_seen_at
         FROM observe_asset_services
         WHERE asset_id = $1::uuid AND tenant_id = $2
         ORDER BY port`,
        [req.params.id, req.auth.tenantId || 'default']
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT i.id, i.title, i.severity, i.status, i.ai_summary, i.ai_suggestion, i.created_at
         FROM observe_incidents i
         WHERE i.host_id = $1::uuid AND i.tenant_id = $2
         ORDER BY i.created_at DESC LIMIT 20`,
        [req.params.id, req.auth.tenantId || 'default']
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT change_type, field_name, old_value, new_value, changed_at
         FROM observe_asset_changes
         WHERE asset_id = $1::uuid AND tenant_id = $2
         ORDER BY changed_at DESC LIMIT 30`,
        [req.params.id, req.auth.tenantId || 'default']
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT iface_name, iface_type, mac_address, ip_addresses, speed_mbps, status
         FROM observe_asset_interfaces
         WHERE asset_id = $1::uuid AND tenant_id = $2
         ORDER BY iface_name`,
        [req.params.id, req.auth.tenantId || 'default']
      ).catch(() => ({ rows: [] }))
    ]);
    await pool.end().catch(() => {});
    
    // Enrich services with IANA port names + fingerprint labels
    const IANA = {20:'FTP-data',21:'FTP',22:'SSH',23:'Telnet',25:'SMTP',53:'DNS',67:'DHCP',68:'DHCP',80:'HTTP',110:'POP3',123:'NTP',143:'IMAP',161:'SNMP',162:'SNMP-trap',389:'LDAP',443:'HTTPS',445:'SMB',465:'SMTPS',514:'Syslog',587:'SMTP-submission',636:'LDAPS',873:'Rsync',993:'IMAPS',995:'POP3S',1433:'MSSQL',1521:'Oracle',2049:'NFS',2181:'ZooKeeper',2375:'Docker',2376:'Docker-TLS',3000:'Grafana/Node',3306:'MySQL',3389:'RDP',4000:'Jupyter/API',4369:'Erlang',5000:'API/Registry',5038:'Asterisk-AMI',5044:'Logstash-Beats',5353:'mDNS',5432:'PostgreSQL',5433:'PostgreSQL',5555:'API/Dev',5665:'Icinga2-API',5672:'RabbitMQ',6379:'Redis',6443:'K8s-API',8000:'HTTP-alt',8080:'HTTP-proxy',8443:'HTTPS-alt',9000:'MinIO/API',9090:'Prometheus',9092:'Kafka',9100:'NodeExporter',9200:'Elasticsearch',9300:'Elasticsearch-node',10050:'Zabbix',11211:'Memcached',27017:'MongoDB'};
    const enrichedServices = (services.rows || []).map(s => {
      let name = s.service_name;
      let banner = '';
      let productHint = '';
      if (s.fingerprint && typeof s.fingerprint === 'object') {
        const f = s.fingerprint;
        if (f.product_hint) productHint = f.product_hint;
        if (f.banner) banner = f.banner;
        if (f.technology && !productHint) productHint = f.technology;
      }
      // Resolve name: fingerprint > IANA > existing
      if (productHint && name.startsWith('port-')) name = productHint;
      else if (name.startsWith('port-') && IANA[s.port]) name = IANA[s.port];
      else if (name.startsWith('port-')) name = s.protocol + '/' + s.port;
      return { ...s, display_name: name, banner, product_hint: productHint };
    });
    
    res.json({ 
      asset: asset.rows[0], 
      services: enrichedServices,
      incidents: incidents.rows || [],
      changes: changes.rows || [],
      interfaces: interfaces.rows || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI settings — lê configuração atual do provider ──────────────────────
app.get(`${BASE}/ai/settings`, requireAuth, async (_req, res) => {
  try {
    await reconcilePersistedAISettings('api_get_settings');
  } catch (e) {
    log('warn', 'Best-effort reconcile on GET /ai/settings failed', { err: e.message });
  }

  const [result, persisted] = await Promise.all([
    proxyToAI('/ai/settings'),
    getPersistedAISettings(),
  ]);

  if (!persisted) {
    return res.status(result.status).json(result.data);
  }

  const merged = {
    ...(result.data || {}),
    provider: persisted.provider,
    model: persisted.model,
    has_api_key: !!persisted.api_key,
    persisted_in_db: true,
    updated_at: persisted.updated_at,
  };

  const status = result.status >= 400 ? 200 : result.status;
  res.status(status).json(merged);
});

// AI settings — atualiza provider/model/api_key em runtime
app.post(`${BASE}/ai/settings`, requireAuth, requireAdmin, requireAIWrite, async (req, res) => {
  const body = req.body || {};
  const provider = Object.prototype.hasOwnProperty.call(body, 'provider')
    ? String(body.provider || '').toLowerCase()
    : undefined;
  if (provider !== undefined && !VALID_AI_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'provider inválido' });
  }

  // Validar formato da API key antes de persistir
  if (body.api_key) {
    const key = String(body.api_key);
    if (key.startsWith('http://') || key.startsWith('https://')) {
      return res.status(400).json({ error: 'api_key inválida: não pode ser uma URL' });
    }
    if (key === 'CHANGE_ME' || key.length < 20) {
      return res.status(400).json({ error: 'api_key inválida: muito curta ou placeholder' });
    }
    const p = provider || body.provider;
    if (p === 'openai'    && !key.startsWith('sk-'))     return res.status(400).json({ error: 'Chaves OpenAI devem começar com "sk-"' });
    if (p === 'anthropic' && !key.startsWith('sk-ant-')) return res.status(400).json({ error: 'Chaves Anthropic devem começar com "sk-ant-"' });

    // Valida a chave no provider antes de persistir (rejeita chave inválida).
    const targetProvider = (provider ?? body.provider ?? '').toLowerCase();
    const validation = await validateProviderKey(targetProvider, key);
    if (!validation.valid) {
      return res.status(400).json({ error: `Chave inválida para ${targetProvider}: o provider rejeitou a autenticação.` });
    }
  }

  const persisted = await upsertPersistedAISettings({
    ...(provider !== undefined ? { provider } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'model') ? { model: body.model } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'api_key') ? { api_key: body.api_key } : {}),
  });

  const payload = { ...body, provider: provider ?? body.provider };
  const result = await proxyToAI('/ai/settings', { method: 'POST', body: JSON.stringify(payload) });
  const serviceUnavailable = !result.ok || result.status >= 500;
  if (result.status >= 400 && !serviceUnavailable) {
    return res.status(result.status).json(result.data);
  }

  res.status(200).json({
    ...(serviceUnavailable ? {} : (result.data || {})),
    ok: true,
    persisted_in_db: true,
    degraded: serviceUnavailable,
    ai_status: serviceUnavailable ? result.status : undefined,
    updated_at: new Date().toISOString(),
    provider: persisted.provider,
    model: persisted.model,
    has_api_key: !!persisted.api_key,
    effective_model: persisted.model === 'auto' ? (AI_AUTO_MODELS[persisted.provider] || '') : persisted.model,
  });
});

// ─── AIOps endpoints (proxy para observe-ai) ────────────────────────────

// RCA — Root Cause Analysis
app.post(`${BASE}/ai/rca`, requireAuth, async (req, res) => {
  const { incident, topology, recent_events, similar_incidents } = req.body;
  if (!incident) return res.status(400).json({ error: 'incident é obrigatório' });
  const result = await proxyToAI('/ai/rca', { method: 'POST', body: JSON.stringify({ incident, topology, recent_events, similar_incidents }) });
  res.status(result.status).json(result.data);
});

// Event Correlation
app.post(`${BASE}/ai/correlate`, requireAuth, async (req, res) => {
  const { events, mode } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events deve ser um array' });
  const result = await proxyToAI('/ai/correlate', { method: 'POST', body: JSON.stringify({ events, mode }) });
  res.status(result.status).json(result.data);
});

// Similar Incidents Search
app.post(`${BASE}/ai/similar-incidents`, requireAuth, async (req, res) => {
  const { incident, min_similarity, max_results } = req.body;
  if (!incident) return res.status(400).json({ error: 'incident é obrigatório' });
  const result = await proxyToAI('/ai/similar-incidents', { method: 'POST', body: JSON.stringify({ incident, min_similarity, max_results }) });
  res.status(result.status).json(result.data);
});

// Knowledge Base Playbooks
app.get(`${BASE}/ai/playbooks`, requireAuth, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const result = await proxyToAI(`/ai/playbooks${qs ? '?' + qs : ''}`);
  res.status(result.status).json(result.data);
});

// Feedback
app.post(`${BASE}/ai/feedback`, requireAuth, async (req, res) => {
  const result = await proxyToAI('/ai/feedback', { method: 'POST', body: JSON.stringify(req.body) });
  res.status(result.status).json(result.data);
});

app.get(`${BASE}/ai/feedback/stats`, requireAuth, async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const result = await proxyToAI(`/ai/feedback/stats${qs ? '?' + qs : ''}`);
  res.status(result.status).json(result.data);
});

app.get(`${BASE}/ai/incidents/stats`, requireAuth, async (_req, res) => {
  const result = await proxyToAI('/ai/incidents/stats');
  res.status(result.status).json(result.data);
});

// Remediation request (manual)
app.post(`${BASE}/remediation/request`, requireAuth, requireAdmin, requireRemediationWrite, validateBody(bodySchemas.remediationRequest), async (req, res) => {
  const { incident_id, action, params, reason } = req.body;
  if (!incident_id || !action) return res.status(400).json({ error: 'incident_id e action são obrigatórios' });
  try {
    const r = await db.query(
      `INSERT INTO observe_remediations
         (incident_id, action, params, reason, status, confidence_score, requested_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending_approval', NULL, NOW(), NOW()) RETURNING *`,
      [incident_id, action, JSON.stringify(params || {}), reason || '']
    );
    log('info', 'Remediation requested', { incident_id, action });
    res.status(202).json({ remediation: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista remediações pendentes de aprovação
app.get(`${BASE}/remediation/pending`, requireAuth, apiLimiter, async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT rem.*, inc.title AS incident_title, inc.severity AS incident_severity
      FROM observe_remediations rem
      LEFT JOIN observe_incidents inc ON rem.incident_id = inc.id
      WHERE rem.status = 'pending_approval'
      ORDER BY rem.requested_at DESC
      LIMIT 50
    `);
    res.json({ remediations: r.rows, total: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aprova e enfileira remediação para execução pelo worker
app.post(`${BASE}/remediation/:id/approve`, requireAuth, requireAdmin, requireRemediationWrite, validateBody(bodySchemas.remediationApprove), async (req, res) => {
  const { id } = req.params;
  const { approved_by } = req.body;
  try {
    const r = await db.query(
      `UPDATE observe_remediations
       SET status = 'approved', approved_by = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'pending_approval'
       RETURNING *`,
      [approved_by || 'api', id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Remediação não encontrada ou já processada' });
    const rem = r.rows[0];
    if (redis) {
      await redis.rpush('observe:remediation:execute', JSON.stringify({
        remediation_id: rem.id,
        incident_id:    rem.incident_id,
        action:         rem.action,
        params:         rem.params,
      }));
    }
    log('info', 'Remediation approved', { id, action: rem.action, approved_by });
    res.json({ remediation: rem, queued: !!redis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rejeita remediação
app.post(`${BASE}/remediation/:id/reject`, requireAuth, requireAdmin, requireRemediationWrite, validateBody(bodySchemas.remediationReject), async (req, res) => {
  const { id } = req.params;
  const { rejected_by, reason } = req.body;
  try {
    const r = await db.query(
      `UPDATE observe_remediations
       SET status = 'rejected', approved_by = $1,
           execution_output = $2, updated_at = NOW()
       WHERE id = $3 AND status = 'pending_approval'
       RETURNING *`,
      [rejected_by || 'api', reason ? `Rejeitado: ${reason}` : 'Rejeitado manualmente', id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Remediação não encontrada ou já processada' });
    log('info', 'Remediation rejected', { id, rejected_by });
    res.json({ remediation: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Prometheus HTTP SD — /observe/api/sd/targets ────────────────────────────
// Retorna targets no formato Prometheus HTTP Service Discovery (RFC).
// O Prometheus consulta este endpoint a cada 30s (configurado em prometheus.yml).
const EXPORTER_PORTS = [
  { port: 9100, job: 'node-exporter' },
  { port: 9104, job: 'mysqld-exporter' },
  { port: 9108, job: 'generic-metrics' },
  { port: 9115, job: 'blackbox-exporter' },
  { port: 9117, job: 'apache-exporter' },
  { port: 9121, job: 'redis-exporter' },
  { port: 9187, job: 'postgres-exporter' },
  { port: 9256, job: 'process-exporter' },
  { port: 9419, job: 'rabbitmq-exporter' },
  { port: 9090, job: 'prometheus' },
  { port: 9091, job: 'pushgateway' },
];

async function probeMetricsEndpoint(address, port) {
  try {
    const resp = await fetch(`http://${address}:${port}/metrics`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return false;
    const text = await resp.text();
    return /^#\s*(HELP|TYPE)/m.test(text);
  } catch {
    return false;
  }
}

app.get(`${BASE}/sd/targets`, async (_req, res) => {
  try {
    const hosts = await db.query(
      `SELECT name, address, metadata FROM observe_hosts
       WHERE address IS NOT NULL ORDER BY updated_at DESC LIMIT 500`
    );

    const groups = [];

    // Hosts descobertos — testa portas de exporters em paralelo
    const probePromises = [];
    for (const host of hosts.rows) {
      if (!host.address) continue;
      for (const { port, job } of EXPORTER_PORTS) {
        probePromises.push(
          probeMetricsEndpoint(host.address, port).then(ok => ok ? {
            target: `${host.address}:${port}`,
            labels: {
              job,
              host:       host.name,
              host_ip:    host.address,
              discovered: 'true',
              source:     'r-observe-db',
            },
          } : null)
        );
      }
    }

    const results = await Promise.all(probePromises);
    for (const r of results) {
      if (r) groups.push({ targets: [r.target], labels: r.labels });
    }

    // Prometheus HTTP SD exige array de { targets, labels }
    res.set('Content-Type', 'application/json');
    res.json(groups);
  } catch (e) {
    res.status(500).json([]);
  }
});

// ─── AI Feedback ─────────────────────────────────────────────────────────────
app.post(`${BASE}/ai/feedback`, requireAuth, async (req, res) => {
  const { incident_id, rating, comment } = req.body;
  if (!incident_id || ![1, -1].includes(Number(rating)))
    return res.status(400).json({ error: 'incident_id e rating (1 ou -1) são obrigatórios' });
  try {
    const r = await db.query(
      `INSERT INTO observe_ai_feedback (incident_id, rating, comment)
       VALUES ($1, $2, $3) RETURNING *`,
      [incident_id, Number(rating), comment || null]
    );
    res.status(201).json({ feedback: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI Activity ─────────────────────────────────────────────────────────────
app.get(`${BASE}/ai/activity`, requireAuth, apiLimiter, async (_req, res) => {
  try {
    res.json(await getAIActivitySnapshot());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI Catalog CRUD ──────────────────────────────────────────────────────────
app.get(`${BASE}/ai/catalog`, requireAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM observe_ai_catalog ORDER BY risk, action');
    res.json({ catalog: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${BASE}/ai/catalog`, requireAuth, requireAdmin, requireAIWrite, async (req, res) => {
  const { action, description, risk, params, auto_ok, max_severity } = req.body;
  if (!action || !description) return res.status(400).json({ error: 'action e description são obrigatórios' });
  try {
    const r = await db.query(
      `INSERT INTO observe_ai_catalog (action, description, risk, params, auto_ok, max_severity)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [action, description, risk || 'medium', JSON.stringify(params || []),
       auto_ok || false, max_severity || 'warning']
    );
    res.status(201).json({ action: r.rows[0] });
  } catch (e) { res.status(e.message.includes('unique') ? 409 : 500).json({ error: e.message }); }
});

app.patch(`${BASE}/ai/catalog/:action`, requireAuth, requireAdmin, requireAIWrite, async (req, res) => {
  const { action } = req.params;
  const { description, risk, params, auto_ok, max_severity, enabled } = req.body;
  try {
    const r = await db.query(
      `UPDATE observe_ai_catalog
       SET description  = COALESCE($1, description),
           risk         = COALESCE($2, risk),
           params       = COALESCE($3, params),
           auto_ok      = COALESCE($4, auto_ok),
           max_severity = COALESCE($5, max_severity),
           enabled      = COALESCE($6, enabled),
           updated_at   = NOW()
       WHERE action = $7 RETURNING *`,
      [description, risk, params ? JSON.stringify(params) : null,
       auto_ok, max_severity, enabled, action]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Ação não encontrada' });
    res.json({ action: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete(`${BASE}/ai/catalog/:action`, requireAuth, requireAdmin, requireAIWrite, async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE observe_ai_catalog SET enabled = false, updated_at = NOW()
       WHERE action = $1 RETURNING action`,
      [req.params.action]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Ação não encontrada' });
    res.json({ disabled: true, action: req.params.action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── UI: login web ──────────────────────────────────────────────────────────
app.get('/observe/login', async (req, res) => {
  const auth = await authenticateRequest(req).catch(() => null);
  if (auth) return res.redirect('/observe/home');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(LOGIN_HTML);
});

// ─── UI: página de configuração do provider de IA ─────────────────────────────
app.get('/observe/settings', requireWebSession, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(SETTINGS_HTML);
});

app.get('/observe/config', requireWebSession, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(SETTINGS_HTML);
});

// ─── UI: home com atalhos das interfaces ────────────────────────────────────
app.get('/observe/home', requireWebSession, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(HOME_HTML);
});

// ─── UI: dashboard de atividade da IA ─────────────────────────────────────────
app.get('/observe/ai', requireWebSession, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(AI_DASHBOARD_HTML);
});

// ─── UI: versões da stack ─────────────────────────────────────────────────────
app.get('/observe/versions', requireWebSession, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(VERSIONS_HTML);
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(createHttpErrorHandler({ log, service: 'r-observe-api' }));

const { createMetricsUpdater } = require('./services/metrics-updater');

// ─── Periodic metrics updater ─────────────────────────────────────────────
const metricsUpdater = createMetricsUpdater({ db, activeIncidentsGauge, activeSessionsGauge, log });

// ─── Start ────────────────────────────────────────────────────────────────────
const { bootstrapInitialUsers } = require('./bootstrap');

(async () => {
  try {
    await initAuth();
    await bootstrapInitialUsers(db, process.env, { log: (line) => process.stdout.write(line + '\n') });
    await applyPersistedAISettingsOnStartup();

    const timer = setInterval(() => {
      reconcilePersistedAISettings('interval').catch((e) => {
        log(AI_SETTINGS_RECONCILE_STRICT ? 'error' : 'debug', 'Periodic AI settings reconcile failed', { err: e.message });
        if (AI_SETTINGS_RECONCILE_STRICT) process.exit(1);
      });
    }, AI_SETTINGS_RECONCILE_INTERVAL_MS);
    timer.unref();

    metricsUpdater.start();
  } catch (e) {
    log('error', 'Startup bootstrap failed', { err: e.message });
    await db.end().catch(() => {});
    if (redis) await redis.quit().catch(() => {});
    process.exit(1);
  }
  const server = app.listen(PORT, '0.0.0.0', () => {
    log('info', `Listening on :${PORT}`, { basePath: BASE });
  });

  const lifecycle = createLifecycle({ label: 'r-observe-api', log });
  lifecycle.onServer(server);
  lifecycle.addCloser('db', () => db.end());
  if (redis) lifecycle.addCloser('redis', () => redis.quit());
  lifecycle.start();
})();

module.exports = app;

// ─── Dev helpers ─────────────────────────────────────────────────────────────
// Em dev: Vite serve os CSS com HMR via /src/ui/main.js.
// Em prod: <link> estático servido por express.static.
const DEV_SCRIPT = IS_DEV
  ? `<script type="module" src="${VITE_DEV_ORIGIN}/src/ui/main.js"></script>`
  : '';

// ─── HTML da UI inicial ──────────────────────────────────────────────────────
const LOGIN_HTML = /* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>R-Observe · Login</title>
  <link rel="icon" href="/results-brand/favicon.svg" type="image/svg+xml">
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --surface:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --brand:#cc1212; --err:#f85149; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font:14px/1.45 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; display:grid; place-items:center; }
    .login { width:min(420px, calc(100vw - 32px)); background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:24px; box-shadow:0 24px 60px rgba(0,0,0,.35); }
    .brand { display:flex; gap:12px; align-items:center; margin-bottom:22px; }
    .logo { width:36px; height:36px; border-radius:8px; background:var(--brand); display:grid; place-items:center; font:900 20px Arial,sans-serif; }
    h1 { margin:0; font-size:1.15rem; }
    p { margin:2px 0 0; color:var(--muted); }
    label { display:block; color:var(--muted); font-size:.82rem; margin:14px 0 6px; }
    input { width:100%; border:1px solid var(--border); border-radius:6px; background:#0d1117; color:var(--text); padding:11px 12px; font:inherit; }
    input:focus-visible, button:focus-visible { outline:3px solid #fff; outline-offset:2px; }
    button { width:100%; margin-top:18px; border:0; border-radius:6px; background:var(--brand); color:#fff; padding:11px 14px; font-weight:800; cursor:pointer; }
    button:disabled { opacity:.65; cursor:not-allowed; }
    .error { min-height:1.3em; margin-top:12px; color:var(--err); font-size:.9rem; }
  </style>
</head>
<body>
  <form class="login" onsubmit="login(event)">
    <div class="brand">
      <div class="logo">R</div>
      <div>
        <h1>R-Observe</h1>
        <p>Acesso operacional</p>
      </div>
    </div>
    <label for="username">Usuário</label>
    <input id="username" name="username" autocomplete="username" required aria-describedby="error" autofocus>
    <label for="password">Senha</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required aria-describedby="error">
    <button id="submit" type="submit">Entrar</button>
    <div id="error" class="error" role="alert" aria-live="assertive"></div>
  </form>
  <script>
    const API = '/observe/api';
    const params = new URLSearchParams(location.search);
    const next = params.get('next') || '/observe/home';

    async function login(event) {
      event.preventDefault();
      const btn = document.getElementById('submit');
      const err = document.getElementById('error');
      btn.disabled = true;
      err.textContent = '';
      try {
        const response = await fetch(API + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value.trim(),
            password: document.getElementById('password').value,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          err.textContent = body.error || 'Falha no login.';
          return;
        }
        sessionStorage.removeItem('observe_token');
        location.href = next.startsWith('/observe/') ? next : '/observe/home';
      } catch (e) {
        err.textContent = 'Não foi possível autenticar agora.';
      } finally {
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

const HOME_HTML = /* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Results · R-Observe</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --card: #161b22;
      --text: #c9d1d9;
      --muted: #8b949e;
      --border: #30363d;
      --brand: #CC1212;
      --shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      color: var(--text);
      background: var(--bg);
      min-height: 100vh;
    }
    .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 24px; display: flex; align-items: center; gap: 10px; }
    .topbar-brand { font-size: .7rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--brand); }
    .topbar-title { font-size: .85rem; color: var(--muted); }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 24px; }
    h1 { margin: 0; font-size: clamp(1.4rem, 2vw, 1.9rem); }
    .sub { margin: 2px 0 0; color: var(--muted); }
    .grid {
      margin-top: 20px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--card);
      border-radius: 14px;
      padding: 16px;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      text-decoration: none;
      color: inherit;
      transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 16px 30px rgba(0, 0, 0, 0.4);
      border-color: var(--brand);
    }
    .card h2 { margin: 0 0 8px; font-size: 1.05rem; color: var(--text); }
    .card p { margin: 0; color: var(--muted); font-size: .94rem; }
	    .tag {
	      display: inline-block;
	      margin-bottom: 8px;
      font-size: .76rem;
      color: var(--brand);
      background: rgba(204, 18, 18, 0.15);
      border: 1px solid rgba(204, 18, 18, 0.3);
      border-radius: 999px;
      padding: 3px 9px;
      font-weight: 700;
	      letter-spacing: .01em;
	      text-transform: uppercase;
	    }
	    .token-panel {
	      margin: 20px auto 0;
	      background: var(--surface);
	      border: 1px solid var(--border);
	      border-radius: 8px;
	      padding: 18px;
	      max-width: 520px;
	      box-shadow: var(--shadow);
	    }
	    .token-panel h2 { margin: 0 0 8px; font-size: 1.05rem; }
	    .token-panel p { margin: 0 0 14px; color: var(--muted); }
	    .token-row { display: flex; gap: 8px; align-items: center; }
	    .token-row input {
	      flex: 1;
	      min-width: 0;
	      background: var(--bg);
	      border: 1px solid var(--border);
	      border-radius: 6px;
	      color: var(--text);
	      font: .9rem Consolas, monospace;
	      padding: 10px 12px;
	    }
	    .token-row button {
	      background: var(--brand);
	      border: 0;
	      border-radius: 6px;
	      color: #fff;
	      cursor: pointer;
	      font-weight: 700;
	      padding: 10px 14px;
	    }
	    .token-row button:disabled { opacity: .6; cursor: not-allowed; }
	    .token-error { color: #f85149; font-size: .86rem; margin-top: 10px; min-height: 1.2em; }
	    .is-hidden { display: none; }
	    @media (max-width: 560px) {
	      .token-row { align-items: stretch; flex-direction: column; }
	    }
	  </style>
	</head>
	<body>
<div class="topbar">
  <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" width="28" height="28" style="flex-shrink:0"><rect width="28" height="28" rx="6" fill="#CC1212"/><text x="14" y="20" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="16" fill="white" text-anchor="middle">R</text></svg>
  <span class="topbar-brand">Results · Sistemas de Informática</span>
  <span class="topbar-title">/ R-Observe Home</span>
  <div style="margin-left:auto;display:flex;gap:.5rem;align-items:center;">
    <a href="/icinga/" class="topbar-link">🔍 Icinga</a>
    <a href="/observe/versions" class="topbar-link">ⓘ Versões</a>
  </div>
</div>
  <main class="wrap">
	    <section id="token-panel" class="token-panel">
	      <h2>Validando sessão</h2>
	      <p>Aguarde enquanto confirmamos seu acesso.</p>
	      <div id="home-token-error" class="token-error"></div>
	    </section>

	    <section id="home-options" class="grid is-hidden">
	      <a class="card" href="/observe/ai">
	        <span class="tag">IA</span>
        <h2>IA Dashboard</h2>
        <p>Atividade, análises, catálogo e remediações com feedback.</p>
      </a>

      <a class="card" href="/observe/settings">
        <span class="tag">Configuração</span>
        <h2>Configuração IA</h2>
        <p>Seleção de provider, modelo e token interno.</p>
      </a>

	      <a class="card" href="${GRAFANA_URL}">
        <span class="tag">Métricas</span>
        <h2>Grafana</h2>
        <p>Dashboards e visualização de indicadores do stack.</p>
      </a>

	      <a class="card" href="${ICINGA_WEB_URL}">
        <span class="tag">Monitoramento</span>
        <h2>Icinga Web 2</h2>
        <p>Status de hosts e serviços com navegação web.</p>
      </a>

	      <a class="card" href="${DISCOVERY_UI_URL}">
        <span class="tag">Discovery</span>
        <h2>Discovery UI</h2>
        <p>Descoberta de ativos e inspeção de varreduras.</p>
	      </a>
	    </section>
	  </main>
	  <script>
	    const tokenPanel = document.getElementById('token-panel');
	    const homeOptions = document.getElementById('home-options');
	    const tokenError = document.getElementById('home-token-error');

	    function showOptions() {
	      tokenPanel.classList.add('is-hidden');
	      homeOptions.classList.remove('is-hidden');
	    }

	    (async () => {
	      try {
	        const response = await fetch('/observe/api/auth/me');
	        if (response.ok) showOptions();
	        else location.href = '/observe/login?next=/observe/home';
	      } catch (_error) {
	        tokenError.textContent = 'Não foi possível validar a sessão agora.';
	      }
	    })();
	  </script>
	</body>
	</html>`;

// ─── HTML da UI de configuração ───────────────────────────────────────────────
const AI_DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Results · R-Observe IA</title>
  ${IS_DEV ? DEV_SCRIPT : '<link rel="stylesheet" href="/observe/api/ui/observe-ai.css">'}
</head>
<body>
<div class="topbar">
  <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" width="28" height="28" style="flex-shrink:0"><rect width="28" height="28" rx="6" fill="#CC1212"/><text x="14" y="20" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="16" fill="white" text-anchor="middle">R</text></svg>
  <span class="topbar-brand">Results · Sistemas de Informática</span>
  <span class="topbar-title">/ R-Observe IA</span>
  <div style="margin-left:auto;display:flex;gap:.5rem;align-items:center;">
    <a href="/observe/home" class="topbar-link">⌂ Home</a>
    <a href="/icinga/" class="topbar-link">🔍 Icinga</a>
    <a href="/observe/settings" class="topbar-link">⚙ Config</a>
    <a href="/observe/versions" class="topbar-link">ⓘ Versões</a>
  </div>
</div>
<div class="header-controls">
  <button class="btn btn-primary btn-sm" onclick="loadAll()" style="flex-shrink:0">↺ Atualizar</button>
  <button class="btn btn-sm" onclick="logout()" style="flex-shrink:0">Sair</button>
  <span id="last-refresh" style="color:var(--muted);font-size:.75rem;margin-left:.25rem"></span>
</div>

<nav role="tablist" aria-label="Seções do dashboard de IA">
  <button id="tab-overview" class="tab active" role="tab" aria-selected="true" aria-controls="overview" tabindex="0" onclick="showTab('overview')">Visão Geral</button>
  <button id="tab-analyses" class="tab" role="tab" aria-selected="false" aria-controls="analyses" tabindex="-1" onclick="showTab('analyses')">Análises</button>
  <button id="tab-catalog" class="tab" role="tab" aria-selected="false" aria-controls="catalog" tabindex="-1" onclick="showTab('catalog')">Catálogo</button>
  <button id="tab-remediations" class="tab" role="tab" aria-selected="false" aria-controls="remediations" tabindex="-1" onclick="showTab('remediations')">Remediações</button>
  <button id="tab-contacts" class="tab" role="tab" aria-selected="false" aria-controls="contacts" tabindex="-1" onclick="showTab('contacts')">Contatos</button>
</nav>

<div id="overview" class="page active" role="tabpanel" aria-labelledby="tab-overview">
  <div class="metrics" id="metrics-grid">
    <div class="metric"><div class="val">—</div><div class="lbl">Analisados</div></div>
  </div>
  <div class="section-title">Comparação Tactical x IA</div>
  <div id="compare-box" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;color:var(--text);margin-bottom:12px">
    Carregando comparação Tactical x IA.
  </div>
  <div class="section-title">Análises Recentes com IA <span style="font-weight:400;color:var(--muted);font-size:.8rem">— últimas 20</span></div>
  <div class="table-wrap">
  <table id="overview-table">
    <thead><tr><th>Incidente</th><th>Severidade</th><th>Resumo IA</th><th>Status</th><th>Data</th></tr></thead>
    <tbody><tr><td colspan="5" class="empty">Carregando dados.</td></tr></tbody>
  </table>
  </div>
</div>

<div id="analyses" class="page" role="tabpanel" aria-labelledby="tab-analyses" hidden>
  <div class="section-title">Todas as Análises <span style="font-weight:400;color:var(--muted);font-size:.8rem">— últimas 20</span></div>
  <div class="table-wrap">
  <table id="analyses-table">
    <thead><tr><th>Título</th><th>Host</th><th>Causa</th><th>Sugestão</th><th>Feedback</th></tr></thead>
    <tbody><tr><td colspan="5" class="empty">Carregando dados.</td></tr></tbody>
  </table>
  </div>
</div>

<div id="catalog" class="page" role="tabpanel" aria-labelledby="tab-catalog" hidden>
  <div class="section-title">Catálogo de Remediações</div>
  <div class="table-wrap">
  <table id="catalog-table">
    <thead><tr><th>Ação</th><th>Descrição</th><th>Risco</th><th>Auto</th><th>Max Sev.</th><th>Status</th><th></th></tr></thead>
    <tbody><tr><td colspan="7" class="empty">Carregando dados.</td></tr></tbody>
  </table>
  </div>
</div>

<div id="remediations" class="page" role="tabpanel" aria-labelledby="tab-remediations" hidden>
  <div class="section-title">Remediações Recentes <span style="font-weight:400;color:var(--muted);font-size:.8rem">— últimas 20</span></div>
  <div class="table-wrap">
  <table id="rem-table">
    <thead><tr><th>Ação</th><th>Status</th><th>Score</th><th>Auto</th><th>Output</th><th>Data</th></tr></thead>
    <tbody><tr><td colspan="6" class="empty">Carregando dados.</td></tr></tbody>
  </table>
  </div>
</div>

<div id="contacts" class="page" role="tabpanel" aria-labelledby="tab-contacts" hidden>
  <div class="section-title">Contatos Operacionais</div>
  <div style="display:grid;grid-template-columns:minmax(220px,320px) 1fr;gap:14px;align-items:start">
    <form onsubmit="createContact(event)" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:12px">
      <div style="font-weight:700;margin-bottom:10px">Novo contato</div>
      <label for="contact-name" style="display:block;color:var(--muted);font-size:.8rem;margin-bottom:4px">Usuário</label>
      <input id="contact-name" style="width:100%;margin-bottom:8px" placeholder="operador@results" required>
      <label for="contact-password" style="display:block;color:var(--muted);font-size:.8rem;margin-bottom:4px">Senha inicial</label>
      <input id="contact-password" type="password" style="width:100%;margin-bottom:8px" placeholder="mínimo 8 caracteres" minlength="8" required>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input id="contact-admin" type="checkbox"> Administrador</label>
      <button class="btn btn-primary btn-sm" type="submit">Criar</button>
    </form>
    <div class="table-wrap">
      <table id="contacts-table">
        <thead><tr><th>Contato</th><th>Ativo</th><th>Admin</th><th>Atualizado</th><th></th></tr></thead>
        <tbody><tr><td colspan="5" class="empty">Carregando dados.</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<div id="toast" role="status" aria-live="polite"></div>

<script>
const API = '/observe/api';
let _data = {};

function getHeaders() {
  const csrf = document.cookie.split('; ').find(value => value.split('=')[0].endsWith('_csrf'));
  return {
    'Content-Type': 'application/json',
    ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf.split('=').slice(1).join('=')) } : {}),
  };
}

function redirectLogin() {
  location.href = '/observe/login?next=' + encodeURIComponent(location.pathname);
}

async function logout() {
  await fetch(API + '/auth/logout', { method: 'POST', headers: getHeaders() }).catch(() => {});
  location.href = '/observe/login?next=/observe/ai';
}

function showTab(id) {
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.hidden = true; });
  document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); t.tabIndex = -1; });
  const panel = document.getElementById(id);
  panel.classList.add('active');
  panel.hidden = false;
  const activeTab = document.querySelector('[onclick="showTab(\\''+id+'\\')"]');
  activeTab.classList.add('active');
  activeTab.setAttribute('aria-selected', 'true');
  activeTab.tabIndex = 0;
}

document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
    (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click();
  tabs[next].focus();
});

function toast(msg, ok) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = ok ? 'ok' : 'err';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, ok ? 3000 : 7000);
}

function badge(cls, text) { return '<span class="badge ' + cls + '">' + text + '</span>'; }
function esc(s) { return String(s||'').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function dt(s) { return s ? new Date(s).toLocaleString('pt-BR', {dateStyle:'short',timeStyle:'short'}) : '—'; }
function showMissingTokenState() {
  const msg = 'Faça login para carregar os dados.';
  document.getElementById('metrics-grid').innerHTML =
    '<div style="color:var(--muted);grid-column:1/-1;padding:1rem">' + msg + '</div>';
  document.getElementById('compare-box').innerHTML = msg;
  [
    ['#overview-table tbody', 5],
    ['#analyses-table tbody', 5],
    ['#catalog-table tbody', 7],
    ['#rem-table tbody', 6],
    ['#contacts-table tbody', 5],
  ].forEach(([selector, colspan]) => {
    const tbody = document.querySelector(selector);
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="empty">' + msg + '</td></tr>';
  });
}

async function loadAll() {
  try {
    const [r, c, contactsResp] = await Promise.all([
      fetch(API + '/ai/activity', { headers: getHeaders() }),
      fetch(API + '/comparison/tactical-ai', { headers: getHeaders() }),
      fetch(API + '/contacts', { headers: getHeaders() }),
    ]);
    if (r.status === 401) { redirectLogin(); return; }
    if (!r.ok) { toast('Erro ' + r.status, false); return; }
    _data = await r.json();
    renderMetrics(_data.metrics);
    renderOverview(_data.recent_analyses);
    renderAnalyses(_data.recent_analyses);
    renderCatalog(_data.catalog);
    renderRemediations(_data.recent_remediations);
    if (c.ok) {
      renderComparison(await c.json());
    } else {
      document.getElementById('compare-box').innerHTML = 'Não foi possível carregar comparação Tactical x IA.';
    }
    renderContacts(contactsResp.ok ? (await contactsResp.json()).contacts || [] : []);
    document.getElementById('last-refresh').textContent =
      'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch(e) { toast('Falha: ' + e.message, false); }
}

function renderComparison(data) {
  const t = data.tactical || { hosts: {}, services: {} };
  const a = data.ai || {};
  const reasons = Array.isArray(data.reasons) ? data.reasons : [];

  function chip(val, label, color, bg, border) {
    return '<span style="display:inline-flex;align-items:center;gap:4px;background:' + bg + ';color:' + color + ';border:1px solid ' + border + ';border-radius:4px;padding:2px 8px;font-size:.78rem;font-weight:600">' +
      val + '<span style="font-weight:400;opacity:.8">' + label + '</span></span>';
  }
  function chipNeutral(val, label) { return chip(val, label, '#8b949e', '#161b22', '#30363d'); }
  function chipGreen(val, label)   { return chip(val, label, '#3fb950', '#0d2316', '#1f5c2e'); }
  function chipYellow(val, label)  { return chip(val, label, '#d29922', '#2d1f00', '#6e4c00'); }
  function chipRed(val, label)     { return chip(val, label, '#f85149', '#2d0e0e', '#6e1b1b'); }

  function row(label, chips) {
    return '<div style="display:flex;align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid #21262d;flex-wrap:wrap">' +
      '<span style="min-width:68px;font-size:.72rem;color:#8b949e;font-weight:700;text-transform:uppercase;letter-spacing:.06em;flex-shrink:0">' + label + '</span>' +
      chips.join('') + '</div>';
  }

  const hTotal = t.hosts.total ?? 0;
  const hUp    = t.hosts.up ?? 0;
  const hDown  = t.hosts.down ?? 0;

  const sTotal = t.services.total ?? 0;
  const sOk    = t.services.ok ?? 0;
  const sWarn  = t.services.warning ?? 0;
  const sCrit  = t.services.critical ?? 0;
  const sUnk   = t.services.unknown ?? 0;

  const aiTotal = a.total_analyzed ?? 0;
  const aiAuto  = a.auto_executed ?? 0;
  const aiPend  = a.pending_approval ?? 0;
  const aiFail  = a.failed ?? 0;

  const hostsRow = row('Hosts', [
    chipNeutral(hTotal, ' total'),
    hUp   > 0 ? chipGreen('↑ ' + hUp, ' up')     : chipNeutral('↑ ' + hUp, ' up'),
    hDown > 0 ? chipRed('↓ ' + hDown, ' down')   : chipNeutral('↓ ' + hDown, ' down'),
  ]);
  const svcRow = row('Serviços', [
    chipNeutral(sTotal, ' total'),
    sOk   > 0 ? chipGreen(sOk, ' ok')             : chipNeutral(sOk, ' ok'),
    sWarn > 0 ? chipYellow(sWarn, ' warning')      : chipNeutral(sWarn, ' warning'),
    sCrit > 0 ? chipRed(sCrit, ' critical')        : chipNeutral(sCrit, ' critical'),
    chipNeutral(sUnk, ' unknown'),
  ]);
  const iaRow = row('IA', [
    chipNeutral(aiTotal, ' analisados'),
    aiAuto > 0 ? chipGreen(aiAuto, ' auto')        : chipNeutral(aiAuto, ' auto'),
    aiPend > 0 ? chipYellow(aiPend, ' pendentes')  : chipNeutral(aiPend, ' pendentes'),
    aiFail > 0 ? chipRed(aiFail, ' falhas')        : chipNeutral(aiFail, ' falhas'),
  ]);

  const reasonHtml = reasons.length
    ? '<ul style="margin:8px 0 0 16px;color:#c9d1d9">' + reasons.map((r) => '<li style="margin:4px 0;font-size:.82rem">' + esc(r) + '</li>').join('') + '</ul>'
    : '<span style="color:#8b949e;font-size:.82rem">Sem diferenças relevantes detectadas agora.</span>';

  const sectionTitle = (t) =>
    '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin-bottom:4px">' + t + '</div>';

  document.getElementById('compare-box').innerHTML =
    sectionTitle('Resumo atual') +
    '<div style="margin-bottom:12px">' + hostsRow + svcRow + iaRow + '</div>' +
    sectionTitle('Motivos da diferença') + reasonHtml;
}

function renderMetrics(m) {
  document.getElementById('metrics-grid').innerHTML = [
    ['green',  m.total_analyzed,   'Analisados'],
    ['yellow', m.auto_executed,    'Auto-executados'],
    ['orange', m.pending_approval, 'Aguardando aprovação'],
    ['ok',     m.succeeded,        'Sucesso'],
    ['red',    m.failed,           'Falhas'],
    ['purple', m.feedback_positive + '👍 / ' + m.feedback_negative + '👎', 'Feedback'],
  ].map(([cls, val, lbl]) =>
    '<div class="metric ' + cls + '"><div class="val">' + val + '</div><div class="lbl">' + lbl + '</div></div>'
  ).join('');
}

function renderOverview(rows) {
  const tb = document.querySelector('#overview-table tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma análise ainda.</td></tr>'; return; }
  tb.innerHTML = rows.map(r => '<tr>' +
    '<td>' + esc(r.title) + '</td>' +
    '<td>' + badge(r.severity, r.severity) + '</td>' +
    '<td><div class="ai-text">' + esc(r.ai_summary || '—') + '</div></td>' +
    '<td>' + badge(r.status, r.status) + '</td>' +
    '<td style="white-space:nowrap">' + dt(r.created_at) + '</td>' +
  '</tr>').join('');
}

function renderAnalyses(rows) {
  const tb = document.querySelector('#analyses-table tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma análise ainda.</td></tr>'; return; }
  tb.innerHTML = rows.map(r => '<tr>' +
    '<td><b>' + esc(r.title) + '</b><br><span style="color:var(--muted);font-size:.75rem">' + esc(r.host_name || '') + '</span></td>' +
    '<td><div class="ai-text">' + esc(r.ai_cause || '—') + '</div></td>' +
    '<td><div class="ai-text">' + esc(r.ai_suggestion || '—') + '</div></td>' +
    '<td><div class="feedback-bar">' +
      '<button class="btn btn-sm" aria-label="Marcar análise como útil" style="background:#1a7f3733;color:var(--green)" onclick="sendFeedback(\\''+r.id+'\\',1)">👍</button>' +
      '<button class="btn btn-sm" aria-label="Marcar análise como não útil" style="background:#da363333;color:var(--red)" onclick="sendFeedback(\\''+r.id+'\\',-1)">👎</button>' +
    '</div></td>' +
  '</tr>').join('');
}

function renderCatalog(rows) {
  const tb = document.querySelector('#catalog-table tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">Catálogo vazio.</td></tr>'; return; }
  tb.innerHTML = rows.map(r => '<tr>' +
    '<td><code style="color:var(--accent)">' + esc(r.action) + '</code></td>' +
    '<td>' + esc(r.description) + '</td>' +
    '<td>' + badge(r.risk, r.risk) + '</td>' +
    '<td>' + (r.auto_ok ? badge('low','sim') : badge('disabled','não')) + '</td>' +
    '<td>' + badge(r.max_severity || 'warning', r.max_severity || 'warning') + '</td>' +
    '<td>' + (r.enabled ? badge('low','ativo') : badge('disabled','desativado')) + '</td>' +
    '<td>' + (r.enabled
      ? '<button class="btn btn-danger btn-sm" onclick="disableAction(\\''+r.action+'\\')">Desativar</button>'
      : '<button class="btn btn-sm" style="background:var(--green);color:#fff" onclick="enableAction(\\''+r.action+'\\')">Ativar</button>') +
    '</td>' +
  '</tr>').join('');
}

function renderRemediations(rows) {
  const tb = document.querySelector('#rem-table tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">Nenhuma remediação ainda.</td></tr>'; return; }
  const colors = { executed:'low', failed:'high', pending_approval:'medium', executing:'ok', rejected:'disabled' };
  tb.innerHTML = rows.map(r => '<tr>' +
    '<td><code style="color:var(--accent)">' + esc(r.action) + '</code></td>' +
    '<td>' + badge(colors[r.status] || 'medium', r.status.replace('_',' ')) + '</td>' +
    '<td>' + (r.confidence_score ? (parseFloat(r.confidence_score)*100).toFixed(0)+'%' : '—') + '</td>' +
    '<td>' + (r.auto_executed ? '✅' : '👤') + '</td>' +
    '<td><div class="ai-text">' + esc(r.execution_output || '—') + '</div></td>' +
    '<td style="white-space:nowrap">' + dt(r.requested_at) + '</td>' +
  '</tr>').join('');
}

function renderContacts(rows) {
  const tb = document.querySelector('#contacts-table tbody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">Nenhum contato encontrado.</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(r => '<tr>' +
    '<td><code style="color:var(--accent)">' + esc(r.name) + '</code></td>' +
    '<td>' + (Number(r.active) === 1 ? badge('low','ativo') : badge('disabled','inativo')) + '</td>' +
    '<td>' + (r.admin ? badge('critical','admin') : badge('disabled','operador')) + '</td>' +
    '<td style="white-space:nowrap">' + dt(r.mtime || r.ctime) + '</td>' +
    '<td><button class="btn btn-sm" onclick="toggleContact(\\'' + esc(r.name) + '\\',' + (Number(r.active) === 1 ? 'false' : 'true') + ')">' +
      (Number(r.active) === 1 ? 'Desativar' : 'Ativar') + '</button></td>' +
  '</tr>').join('');
}

async function createContact(ev) {
  ev.preventDefault();
  const name = document.getElementById('contact-name').value.trim();
  const password = document.getElementById('contact-password').value;
  const admin = document.getElementById('contact-admin').checked;
  const r = await fetch(API + '/contacts', {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ name, password, admin }),
  });
  const d = await r.json().catch(() => ({}));
  toast(r.ok ? 'Contato criado' : (d.error || 'Erro ao criar contato'), r.ok);
  if (r.ok) {
    document.getElementById('contact-name').value = '';
    document.getElementById('contact-password').value = '';
    document.getElementById('contact-admin').checked = false;
    loadAll();
  }
}

async function toggleContact(name, active) {
  const r = await fetch(API + '/contacts/' + encodeURIComponent(name), {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ active }),
  });
  toast(r.ok ? 'Contato atualizado' : 'Erro ao atualizar contato', r.ok);
  if (r.ok) loadAll();
}

async function sendFeedback(incidentId, rating) {
  const r = await fetch(API + '/ai/feedback', {
    method: 'POST', headers: getHeaders(),
    body: JSON.stringify({ incident_id: incidentId, rating }),
  });
  toast(r.ok ? (rating > 0 ? '👍 Feedback positivo enviado' : '👎 Feedback negativo enviado') : 'Erro ao enviar feedback', r.ok);
  if (r.ok) loadAll();
}

async function disableAction(action) {
  if (!confirm('Desativar a ação "' + action + '"?')) return;
  const r = await fetch(API + '/ai/catalog/' + action, { method: 'DELETE', headers: getHeaders() });
  toast(r.ok ? 'Ação "' + action + '" desativada' : 'Erro', r.ok);
  if (r.ok) loadAll();
}

async function enableAction(action) {
  const r = await fetch(API + '/ai/catalog/' + action, {
    method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ enabled: true }),
  });
  toast(r.ok ? 'Ação "' + action + '" ativada' : 'Erro', r.ok);
  if (r.ok) loadAll();
}

loadAll();
setInterval(loadAll, 30000);
</script>
</body>
</html>`;
const SETTINGS_HTML = /* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>R-Observe · Configuração</title>
  ${IS_DEV ? DEV_SCRIPT : '<link rel="stylesheet" href="/observe/api/ui/observe-settings.css">'}
</head>
<body>
<div class="topbar">
  <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" width="28" height="28" style="flex-shrink:0"><rect width="28" height="28" rx="6" fill="#CC1212"/><text x="14" y="20" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="16" fill="white" text-anchor="middle">R</text></svg>
  <span class="topbar-brand">Results · Sistemas de Informática</span>
  <span class="topbar-title">/ R-Observe · Configuração</span>
  <div style="margin-left:auto;display:flex;gap:.5rem;align-items:center;">
    <a href="/observe/home" class="topbar-link">⌂ Home</a>
    <a href="/observe/ai" class="topbar-link">IA Dashboard</a>
    <a href="/icinga/" class="topbar-link">🔍 Icinga</a>
    <a href="/observe/versions" class="topbar-link">ⓘ Versões</a>
    <button class="topbar-link" onclick="logout()" style="border:1px solid var(--border);background:transparent;cursor:pointer">Sair</button>
  </div>
</div>
<div class="settings-page">

  <!-- Status Cards -->
  <div class="status-cards" id="status-cards">
    <div class="status-card ok"><div class="card-value" id="st-ai">—</div><div class="card-label">IA Provider</div></div>
    <div class="status-card ok"><div class="card-value" id="st-agents">0/0</div><div class="card-label">Agentes Discovery</div></div>
    <div class="status-card ok"><div class="card-value" id="st-assets">0</div><div class="card-label">Ativos Monitorados</div></div>
    <div class="status-card warn"><div class="card-value" id="st-whatsapp">—</div><div class="card-label">WhatsApp</div></div>
  </div>

  <!-- Tabs -->
  <div class="tabs" role="tablist" aria-label="Seções de configuração">
    <button id="settings-tab-discovery" class="tab-btn active" role="tab" aria-selected="true" aria-controls="settings-panel" tabindex="0" data-tab="discovery" onclick="switchTab('discovery')">🔍 Descoberta</button>
    <button id="settings-tab-ai" class="tab-btn" role="tab" aria-selected="false" aria-controls="settings-panel" tabindex="-1" data-tab="ai" onclick="switchTab('ai')">🤖 IA</button>
    <button id="settings-tab-agents" class="tab-btn" role="tab" aria-selected="false" aria-controls="settings-panel" tabindex="-1" data-tab="agents" onclick="switchTab('agents')">📡 Agentes</button>
    <button id="settings-tab-os" class="tab-btn" role="tab" aria-selected="false" aria-controls="settings-panel" tabindex="-1" data-tab="os" onclick="switchTab('os')">💻 SO</button>
    <button id="settings-tab-certs" class="tab-btn" role="tab" aria-selected="false" aria-controls="settings-panel" tabindex="-1" data-tab="certs" onclick="switchTab('certs')">🔒 Certs</button>
    <button id="settings-tab-monitoring" class="tab-btn" role="tab" aria-selected="false" aria-controls="settings-panel" tabindex="-1" data-tab="monitoring" onclick="switchTab('monitoring')">📊 Monitoramento</button>
    <button id="settings-tab-whatsapp" class="tab-btn" role="tab" aria-selected="false" aria-controls="settings-panel" tabindex="-1" data-tab="whatsapp" onclick="switchTab('whatsapp')">💬 WhatsApp</button>
    <button id="settings-tab-messages" class="tab-btn" role="tab" aria-selected="false" aria-controls="settings-panel" tabindex="-1" data-tab="messages" onclick="switchTab('messages')">📨 Mensagens</button>
  </div>

  <div class="settings-layout">
    <div class="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-discovery">
      <!-- Content rendered dynamically by switchTab() -->
    </div>

    <div class="settings-aside">
      <div class="aside-panel">
        <div class="panel-title">Status ao Vivo</div>
        <div class="status-bar"><span class="dot ok" id="sd-ai"></span><span class="status-text" id="st-ai-text">IA</span><span class="status-value" id="sv-ai">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-agents"></span><span class="status-text">Agentes Discovery</span><span class="status-value" id="sv-agents">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-assets"></span><span class="status-text">Ativos</span><span class="status-value" id="sv-assets">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-ports"></span><span class="status-text">Port Change</span><span class="status-value" id="sv-ports">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-certs"></span><span class="status-text">Cert Check</span><span class="status-value" id="sv-certs">—</span></div>
      </div>

      <div class="aside-panel">
        <div class="panel-title">Ações</div>
        <button class="btn btn-secondary" onclick="loadStatus()" style="width:100%;margin-bottom:.5rem">↺ Atualizar Status</button>
        <button id="save-section-btn" class="btn btn-primary" onclick="saveAllSettings()" style="width:100%" disabled>💾 Salvar seção</button>
        <div id="dirty-status" class="hint" role="status" aria-live="polite" style="margin-top:.75rem">Nenhuma alteração pendente.</div>
        <div id="feedback" role="status" aria-live="polite" style="margin-top:1rem"></div>
      </div>
    </div>
  </div>
</div>

<script>
const API = '/observe/api';
let _allSettings = {};
let _aiProvider = 'mock';
let _aiModel = 'auto';
let _aiLoaded = false;
let _activeSettingsTab = null;
let _settingsReady = false;
const AUTO_LABELS = { openai:'gpt-4o-mini', anthropic:'claude-haiku-4-5-20251001', deepseek:'deepseek-chat' };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => { if (k==='className') el.className=v; else el.setAttribute(k,v); });
  (function walk(arr){ arr.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c instanceof Node) el.appendChild(c); else if (Array.isArray(c)) walk(c); }); })(children);
  return el;
}

function toggle(id) {
  return h('div', {className:'toggle-row'}, [
    h('span', {}, [h('span', {className:'toggle-label'}, id), h('div', {className:'toggle-desc'}, '')]),
    h('label', {className:'toggle-switch'}, [
      h('input', {type:'checkbox', id:'tog-'+id, onchange:'markDirty()'}),
      h('span', {className:'toggle-slider'})
    ])
  ]);
}

function slider(id, min, max, step, val, unit) {
  return h('div', {className:'slider-row'}, [
    h('input', {type:'range', id:'sld-'+id, min:String(min), max:String(max), step:String(step||1), value:String(val), oninput:'document.getElementById(\"sldv-'+id+'\").textContent=this.value+\"'+unit+'\";markDirty()'}),
    h('span', {className:'slider-value', id:'sldv-'+id}, val+unit)
  ]);
}

function numberField(id,label,val,unit) {
  return h('div',{className:'field'},[
    h('label',{},label),
    h('input',{type:'number',id:'num-'+id,value:String(val),style:'width:100%',onchange:'markDirty()'},''),
    unit?h('div',{className:'hint'},unit):null
  ]);
}

let _dirty = false;
function markDirty(){
  _dirty=true;
  document.getElementById('save-section-btn').disabled=false;
  document.getElementById('dirty-status').textContent='Alterações não salvas nesta seção.';
}
function saveAllSettings(){
  const body = readCurrentSettings();
  const button = document.getElementById('save-section-btn');
  button.disabled=true;
  fetch(API+'/system/settings',{method:'POST',headers:getHeaders(),body:JSON.stringify(body)})
    .then(async r=>({ok:r.ok,data:await r.json()})).then(({ok,data:d})=>{
      if(!ok) throw new Error(d.error||'Não foi possível salvar');
      _dirty=false;
      document.getElementById('dirty-status').textContent='Nenhuma alteração pendente.';
      showFeedback(d.ok?'Configuração salva com sucesso':'Erro ao salvar',d.ok);
    }).catch(e=>{button.disabled=false;showFeedback('Erro: '+e.message,false);});
}
function readCurrentSettings(){
  if(_activeSettingsTab==='discovery') return { discovery: {
      scan_interval_minutes: parseInt(document.getElementById('sld-scan_interval')?.value||60),
      port_change_detection: document.getElementById('tog-port_change')?.checked,
      port_disappeared_grace_scans: parseInt(document.getElementById('sld-grace')?.value||2),
      arp_enabled: document.getElementById('tog-discovery_arp')?.checked,
      docker_enabled: document.getElementById('tog-discovery_docker')?.checked,
      cloud_enabled: document.getElementById('tog-discovery_cloud')?.checked,
      passive_enabled: document.getElementById('tog-discovery_passive')?.checked,
      scan_parallel: parseInt(document.getElementById('sld-scan_parallel')?.value||20),
      extra_ports: document.getElementById('txt-extra_ports')?.value || '',
    }};
  if(_activeSettingsTab==='agents') return { agents: {
      offline_check_enabled: document.getElementById('tog-agent_offline')?.checked,
      offline_threshold_minutes: parseInt(document.getElementById('sld-agent_timeout')?.value||5),
      check_interval_seconds: parseInt(document.getElementById('sld-agent_check_interval')?.value||60),
      disk_warn_percent: parseInt(document.getElementById('sld-agent_disk_warn')?.value||80),
      docker_projects: [...(document.getElementById('sel-docker_projects')?.selectedOptions||[])].map(o=>o.value).join(','),
      docker_ignore_containers: [...(document.getElementById('sel-docker_ignore')?.selectedOptions||[])].map(o=>o.value).join(','),
    }};
  if(_activeSettingsTab==='certs') return { certs: {
      expiry_warning_days: parseInt(document.getElementById('sld-cert_warn')?.value||30),
      expiry_critical_days: parseInt(document.getElementById('sld-cert_crit')?.value||7),
    }};
  if(_activeSettingsTab==='os') return { os_defaults: {
      linux_node_exporter: document.getElementById('tog-os_linux')?.checked,
      windows_exporter: document.getElementById('tog-os_win')?.checked,
      network_snmp: document.getElementById('tog-os_snmp')?.checked,
    }};
  if(_activeSettingsTab==='monitoring') return { monitoring: {
      icinga_sync_enabled: document.getElementById('tog-mon_icinga')?.checked,
      prometheus_sd_enabled: document.getElementById('tog-mon_prometheus')?.checked,
    }};
  return {};
}

function showFeedback(msg,ok){
  const el=document.getElementById('feedback');
  el.textContent=msg;el.className=ok?'ok':'err';
  setTimeout(()=>{el.textContent='';el.className='';},4000);
}

function showToast(msg,type){
  type=type||'ok';
  const existing=document.querySelector('.toast');
  if(existing)existing.remove();
  const el=document.createElement('div');
  el.className='toast '+type;
  el.textContent=msg;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  setTimeout(()=>{el.classList.remove('show');setTimeout(()=>el.remove(),250);},4000);
}

function switchTab(tab){
  if(_activeSettingsTab && tab!==_activeSettingsTab && _dirty && !confirm('Descartar as alterações não salvas desta seção?')) return;
  if(tab!==_activeSettingsTab){
    _dirty=false;
    document.getElementById('save-section-btn').disabled=true;
    document.getElementById('dirty-status').textContent='Nenhuma alteração pendente.';
  }
  _activeSettingsTab=tab;
  document.getElementById('save-section-btn').hidden=tab==='ai'||tab==='whatsapp'||tab==='messages';
  document.getElementById('dirty-status').hidden=tab==='ai'||tab==='whatsapp'||tab==='messages';
  document.querySelectorAll('.tab-btn').forEach(b=>{
    const active=b.dataset.tab===tab;
    b.classList.toggle('active',active);
    b.setAttribute('aria-selected',String(active));
    b.tabIndex=active?0:-1;
  });
  document.getElementById('settings-panel').setAttribute('aria-labelledby','settings-tab-'+tab);
  // Aba Mensagens usa a largura toda (tabela de auditoria); demais mantêm o aside.
  document.querySelector('.settings-layout').classList.toggle('messages-full',tab==='messages');
  const p=document.getElementById('settings-panel');
  if(tab==='discovery') renderDiscovery(p);
  else if(tab==='ai') renderAI(p);
  else if(tab==='agents') renderAgents(p);
  else if(tab==='os') renderOS(p);
  else if(tab==='certs') renderCerts(p);
  else if(tab==='monitoring') renderMonitoring(p);
  else if(tab==='whatsapp') renderWhatsApp(p);
  else if(tab==='messages') renderMessages(p);
}

document.querySelector('.tabs[role="tablist"]').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=[...document.querySelectorAll('.tab-btn')];
  const current=tabs.indexOf(document.activeElement);
  if(current<0)return;
  event.preventDefault();
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:
    (current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  tabs[next].click();tabs[next].focus();
});

addEventListener('beforeunload',event=>{if(_dirty){event.preventDefault();event.returnValue='';}});

// ── Discovery Tab ──
function renderDiscovery(el){
  const s=_allSettings.discovery||{};
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Configuração de Descoberta'));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'sld-scan_interval'},'Intervalo de Scan'),slider('scan_interval',1,1440,5,s.scan_interval_minutes??60,' min')
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('div',{},toggle('port_change')),
    h('div',{className:'toggle-desc'},'Detectar portas que abriram ou fecharam entre scans'),
    h('div',{style:'margin-top:.8rem'},[
      h('label',{for:'sld-grace'},'Scans antes de alertar porta fechada'),
      slider('grace',1,10,1,s.port_disappeared_grace_scans??2,' scans')
    ])
  ]));
  document.getElementById('tog-port_change').checked=s.port_change_detection??true;
  el.appendChild(h('div',{className:'field'},[toggle('discovery_arp'),h('div',{className:'toggle-desc'},'Descoberta via ARP (rede local)')]));
  el.appendChild(h('div',{className:'field'},[toggle('discovery_docker'),h('div',{className:'toggle-desc'},'Descoberta de contêineres Docker')]));
  el.appendChild(h('div',{className:'field'},[toggle('discovery_cloud'),h('div',{className:'toggle-desc'},'Descoberta de recursos Cloud (AWS)')]));
  el.appendChild(h('div',{className:'field'},[toggle('discovery_passive'),h('div',{className:'toggle-desc'},'Listeners passivos (syslog, netflow, traps)')]));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sld-scan_parallel'},'Scans paralelos'),slider('scan_parallel',1,100,1,s.scan_parallel??20,'')]));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'txt-extra_ports'},'Portas extras (separadas por vírgula)'),h('input',{type:'text',id:'txt-extra_ports',value:s.extra_ports||'',placeholder:'Ex: 8080,8443,9090',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));
  document.getElementById('tog-discovery_arp').checked=s.arp_enabled??true;
  document.getElementById('tog-discovery_docker').checked=s.docker_enabled??false;
  document.getElementById('tog-discovery_cloud').checked=s.cloud_enabled??false;
  document.getElementById('tog-discovery_passive').checked=s.passive_enabled??true;
}
// ── AI Tab ──
function renderAI(el){
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Provider de IA'));
  const provs=h('div',{className:'providers'});
  ['openai','anthropic','deepseek','mock'].forEach(p=>{
    const b=h('button',{className:'provider-btn'+(p===_aiProvider?' active':''),'data-provider':p,onclick:'selectAIProvider("'+p+'")'},[
      h('span',{className:'provider-icon'},p==='openai'?'🤖':p==='anthropic'?'🟠':p==='deepseek'?'🔍':'🧪'),
      p==='openai'?'OpenAI':p==='anthropic'?'Anthropic':p==='deepseek'?'DeepSeek':'Mock'
    ]);
    provs.appendChild(b);
  });
  el.appendChild(provs);
  if(_aiProvider!=='mock'){
    el.appendChild(h('div',{className:'field',id:'model-section'},[
      h('label',{},'Modelo'),h('select',{id:'model',onchange:'markDirty()'},''),
      h('div',{className:'effective-model',id:'effective-model'},'')
    ]));
    el.appendChild(h('div',{className:'field',id:'api-key-section'},[
      h('label',{for:'api-key'},'API Key'),
      h('div',{className:'key-row'},[
        h('input',{type:'password',id:'api-key',placeholder:'Cole a chave aqui',autocomplete:'new-password',oninput:'markDirty()'}),
        h('button',{className:'toggle-btn',type:'button',onclick:'toggleKey()','aria-label':'Mostrar ou ocultar API key'},'👁')
      ]),
      h('div',{className:'hint'},'Deixe em branco para manter a chave atual.')
    ]));
  }
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'sld-ai_threshold'},'Auto-Remediation Threshold'),slider('ai_threshold',0,100,5,85,'%'),
    h('div',{className:'hint'},'Score mínimo para execução automática de remediações')
  ]));
  el.appendChild(h('div',{className:'actions'},[
    h('button',{className:'btn btn-secondary',onclick:'loadAIStatus()'},'↺ Atualizar'),
    h('button',{className:'btn btn-primary',id:'save-ai-btn',onclick:'saveAISettings()'},'Salvar IA')
  ]));
  if(_aiProvider!=='mock') loadModels(_aiProvider,_aiModel);
}
// ── Agents Tab ──
function renderAgents(el){
  const s=_allSettings.agents||{};
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Configuração de Agentes'));
  el.appendChild(h('div',{className:'field'},[toggle('agent_offline'),h('div',{className:'toggle-desc'},'Detectar agentes que pararam de responder')]));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sld-agent_timeout'},'Tempo para considerar offline'),slider('agent_timeout',1,60,1,s.offline_threshold_minutes??5,' min')]));
  document.getElementById('tog-agent_offline').checked=s.offline_check_enabled??true;
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sld-agent_check_interval'},'Intervalo de check do agente'),slider('agent_check_interval',10,600,10,s.check_interval_seconds??60,' seg')]));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sld-agent_disk_warn'},'Alerta de disco (%)'),slider('agent_disk_warn',50,99,1,s.disk_warn_percent??80,'%')]));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sel-docker_projects'},'Projetos Docker monitorados'),h('select',{id:'sel-docker_projects',multiple:'',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-height:100px',onchange:'markDirty()'},[h('option',{value:'infra'},'infra'),h('option',{value:'infra-httpd'},'infra-httpd'),h('option',{value:'infra-mail'},'infra-mail'),h('option',{value:'dns-consolidated'},'dns-consolidated'),h('option',{value:'edge-sni'},'edge-sni'),h('option',{value:'r-observe'},'r-observe')])]));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sel-docker_ignore'},'Contêineres ignorados'),h('select',{id:'sel-docker_ignore',multiple:'',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;min-height:100px',onchange:'markDirty()'},[h('option',{value:'results-mail-certs-bootstrap'},'results-mail-certs-bootstrap'),h('option',{value:'results-mail-certs'},'results-mail-certs'),h('option',{value:'portainer'},'portainer'),h('option',{value:'librenms'},'librenms')])]));
  const projects=new Set(String(s.docker_projects||'').split(',').filter(Boolean));
  const ignored=new Set(String(s.docker_ignore_containers||'').split(',').filter(Boolean));
  [...document.getElementById('sel-docker_projects').options].forEach(o=>o.selected=projects.has(o.value));
  [...document.getElementById('sel-docker_ignore').options].forEach(o=>o.selected=ignored.has(o.value));
}
// ── OS Tab ──
function renderOS(el){
  const s=_allSettings.os_defaults||{};
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Monitoramento por Sistema Operacional'));
  el.appendChild(h('div',{className:'field'},[toggle('os_linux'),h('div',{className:'toggle-desc'},'Adicionar node_exporter automaticamente ao detectar Linux')]));
  el.appendChild(h('div',{className:'field'},[toggle('os_win'),h('div',{className:'toggle-desc'},'Adicionar windows_exporter ao detectar Windows')]));
  el.appendChild(h('div',{className:'field'},[toggle('os_snmp'),h('div',{className:'toggle-desc'},'Adicionar SNMP exporter ao detectar switches/roteadores')]));
  document.getElementById('tog-os_linux').checked=s.linux_node_exporter??true;
  document.getElementById('tog-os_win').checked=s.windows_exporter??true;
  document.getElementById('tog-os_snmp').checked=s.network_snmp??true;
}
// ── Monitoring Tab ──
function renderMonitoring(el){
  const s=_allSettings.monitoring||{};
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Monitoramento'));
  el.appendChild(h('div',{className:'field'},[toggle('mon_icinga'),h('div',{className:'toggle-desc'},'Sincronizar hosts com Icinga2')]));
  el.appendChild(h('div',{className:'field'},[toggle('mon_prometheus'),h('div',{className:'toggle-desc'},'Gerar Prometheus Service Discovery (file_sd)')]));
  document.getElementById('tog-mon_icinga').checked=s.icinga_sync_enabled??true;
  document.getElementById('tog-mon_prometheus').checked=s.prometheus_sd_enabled??true;
}
// ── Certs Tab ──
function renderCerts(el){
  const s=_allSettings.certs||{};
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Verificação de Certificados TLS'));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sld-cert_warn'},'Alertar quando expirar em (dias)'),slider('cert_warn',7,90,1,s.expiry_warning_days??30,' dias')]));
  el.appendChild(h('div',{className:'field'},[h('label',{for:'sld-cert_crit'},'Alerta crítico quando restarem (dias)'),slider('cert_crit',1,14,1,s.expiry_critical_days??7,' dias')]));
}

// ── WhatsApp Tab ──
let _whatsapp={enabled:false,phone_number_id:'',recipient:'',severity_filter:'critical',token_set:false,webhook_verify_token:'',app_secret_set:false,webhook_path:'/observe/api/whatsapp/webhook'};
function renderWhatsApp(el){
  const w=_whatsapp||{};
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Notificações via WhatsApp Business'));
  el.appendChild(h('details',{className:'wa-help'},[
    h('summary',{},'ℹ️ Como obter o token e os dados'),
    h('ol',{className:'wa-help-steps'},[
      h('li',{},[h('strong',{},'1. App e número: '),'crie um app do tipo Business no ',h('a',{href:'https://developers.facebook.com/apps',target:'_blank',rel:'noopener',style:'color:var(--accent-h)'},'Meta for Developers'),', adicione o produto WhatsApp e conecte um número de teste.']),
      h('li',{},[h('strong',{},'2. Token: '),'em ',h('a',{href:'https://business.facebook.com/',target:'_blank',rel:'noopener',style:'color:var(--accent-h)'},'Business Settings'),' → Usuários → Usuários do sistema → Gerar token, com as permissões ',h('code',{},'whatsapp_business_messaging'),' e ',h('code',{},'whatsapp_business_management'),'.']),
      h('li',{},[h('strong',{},'3. Phone Number ID: '),'em WhatsApp → Gerenciador de API (API Setup), ao lado do número de teste.']),
      h('li',{},[h('strong',{},'4. Destinatário de teste: '),'adicione o número em API Setup → "To:" (máx. 5) e confirme o opt-in enviando o código a partir do número de teste.']),
      h('li',{},[h('strong',{},'5. Webhook (chat): '),'em WhatsApp → Configuration → Webhook, aponte para a URL de callback abaixo e informe o mesmo Verify Token. Assim você poderá enviar comandos (status, alertas, ativos) pelo WhatsApp.'])
    ]),
    h('div',{className:'wa-help-links'},[
      h('a',{href:'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',target:'_blank',rel:'noopener'},'Guia oficial Cloud API ↗'),
      h('a',{href:'https://developers.facebook.com/apps',target:'_blank',rel:'noopener'},'Meta for Developers ↗')
    ])
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{className:'toggle-switch',style:'display:inline-flex;align-items:center;gap:.6rem;cursor:pointer'},[
      h('input',{type:'checkbox',id:'tog-wa_enabled',onchange:'markDirty()'}),
      h('span',{className:'toggle-slider'})
    ]),
    h('div',{className:'toggle-desc'},'Enviar notificações de incidentes pelo WhatsApp')
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'wa-phone'},'Phone Number ID'),
    h('input',{type:'text',id:'wa-phone',value:w.phone_number_id||'',placeholder:'Ex: 109092465222526',autocomplete:'off',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',oninput:'markDirty()'})
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'wa-recipient'},'Destinatário (formato E.164)'),
    h('input',{type:'text',id:'wa-recipient',value:w.recipient||'',placeholder:'Ex: 15550123456',autocomplete:'off',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',oninput:'markDirty()'})
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'wa-severity'},'Severidade mínima para notificar'),
    h('select',{id:'wa-severity',onchange:'markDirty()',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px'},[
      h('option',{value:'critical'},'Somente crítico'),
      h('option',{value:'warning'},'Crítico + warning'),
      h('option',{value:'all'},'Todos')
    ])
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'wa-token'},'Access Token'),
    h('input',{type:'password',id:'wa-token',value:'',placeholder:w.token_set?'•••••••• (mantido)':'Cole o token de acesso',autocomplete:'new-password',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',oninput:'markDirty()'}),
    h('div',{className:'hint'},w.token_set?'Token salvo — deixe em branco para manter o atual.':'O token é armazenado no banco e nunca é exibido novamente.')
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'wa-webhook-url'},'URL de callback (webhook)'),
    h('input',{type:'text',id:'wa-webhook-url',value:(location.origin||'')+(w.webhook_path||'/observe/api/whatsapp/webhook'),readonly:'',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onclick:'this.select()'}),
    h('div',{className:'hint'},'Use esta URL no Meta (deve ser HTTPS público). No deploy remoto, troque o domínio pelo endereço público do R-Observe.')
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'wa-verify-token'},'Verify Token (webhook)'),
    h('input',{type:'text',id:'wa-verify-token',value:w.webhook_verify_token||'',placeholder:'Token que você informará no Meta',autocomplete:'off',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',oninput:'markDirty()'})
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('label',{for:'wa-app-secret'},'App Secret (assinatura)'),
    h('input',{type:'password',id:'wa-app-secret',value:'',placeholder:w.app_secret_set?'•••••••• (mantido)':'App Secret do app Meta',autocomplete:'new-password',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',oninput:'markDirty()'}),
    h('div',{className:'hint'},w.app_secret_set?'App Secret salvo — deixe em branco para manter.':'Opcional, mas recomendado: valida a assinatura das mensagens recebidas.')
  ]));
  el.appendChild(h('div',{className:'actions'},[
    h('button',{className:'btn btn-secondary',type:'button',onclick:'loadWhatsApp()'},'↺ Atualizar'),
    h('button',{className:'btn btn-secondary',type:'button',id:'wa-test-btn',onclick:'openWhatsAppTestModal()'},'📱 Enviar teste'),
    h('button',{className:'btn btn-primary',type:'button',onclick:'saveWhatsApp()'},'Salvar WhatsApp')
  ]));
  // ── Canal QR (alternativo, não-oficial) ──
  el.appendChild(h('div',{className:'panel-title',style:'margin-top:1.5rem'},'Canal QR (alternativo, não-oficial)'));
  el.appendChild(h('div',{className:'hint'},'Conecta um número WhatsApp lendo um QR Code (whatsapp-web.js). Serve como fallback: se a Cloud API acima não estiver configurada, os alertas saem por este canal. O pareamento roda no worker.'));
  el.appendChild(h('div',{id:'wa-qr-box'}));
  // ── Log de conexões (eventos persistentes dos canais QR/Cloud) ──
  el.appendChild(h('div',{className:'panel-title',style:'margin-top:1.5rem'},'Log de conexões'));
  el.appendChild(h('div',{className:'field',style:'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap'},[
    h('select',{id:'wa-conn-channel',onchange:'loadWaConnLog()',style:'padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;width:auto'},[
      h('option',{value:''},'Todos os canais'),
      h('option',{value:'qr'},'QR'),
      h('option',{value:'cloud'},'Cloud')
    ]),
    h('button',{className:'btn btn-secondary',type:'button',title:'Atualizar log',onclick:'loadWaConnLog()'},'↺')
  ]));
  el.appendChild(h('div',{id:'wa-conn-log',style:'overflow-x:auto'},'Carregando…'));
  renderWhatsAppQr();
  loadWhatsAppQr();
  loadWaConnLog();
  document.getElementById('tog-wa_enabled').checked=!!w.enabled;
  document.getElementById('wa-severity').value=w.severity_filter||'critical';
}
// ── WhatsApp QR (canal alternativo) ──
let _waQr={enabled:false,status:'disconnected',qrDataUrl:null,qrExpiresAt:null,lastError:null};
const WA_QR_STATUS_LABELS={pairing:'Aguardando leitura do QR',connected:'Autenticado, sincronizando…',ready:'Conectado',disconnected:'Desconectado',error:'Erro'};
function renderWhatsAppQr(){
  const box=document.getElementById('wa-qr-box');
  if(!box)return;
  const q=_waQr||{};
  box.innerHTML='';
  const chipStyle='display:inline-block;padding:.35rem .6rem;background:var(--bg);border:1px solid var(--border);border-radius:4px';
  box.appendChild(h('div',{className:'field'},[
    h('label',{className:'toggle-switch',style:'display:inline-flex;align-items:center;gap:.6rem;cursor:pointer'},[
      h('input',{type:'checkbox',id:'tog-wa_qr_enabled',onchange:'toggleWhatsAppQr()'}),
      h('span',{className:'toggle-slider'})
    ]),
    h('div',{className:'toggle-desc'},'Habilitar canal QR (requer WHATSAPP_QR_ENABLED=true no worker)')
  ]));
  box.appendChild(h('div',{className:'field',style:'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap'},[
    h('span',{id:'wa-qr-status',style:chipStyle},'Status: '+(WA_QR_STATUS_LABELS[q.status]||q.status||'—')),
    h('button',{className:'btn btn-secondary',type:'button',id:'wa-qr-connect-btn',onclick:'connectWhatsAppQr()'},'Conectar / Gerar QR'),
    h('button',{className:'btn btn-secondary',type:'button',id:'wa-qr-disconnect-btn',onclick:'disconnectWhatsAppQr(false)'},'Desconectar')
  ]));
  if(q.qrDataUrl){
    box.appendChild(h('div',{className:'field'},[
      h('img',{id:'wa-qr-img',src:q.qrDataUrl,alt:'QR Code do WhatsApp',style:'width:220px;height:220px;background:#fff;padding:.5rem;border:1px solid var(--border);border-radius:4px'}),
      h('div',{className:'hint'},'No WhatsApp: Aparelhos conectados → Conectar aparelho → aponte a câmera para o código.'+(q.qrExpiresAt?(' Válido até '+new Date(q.qrExpiresAt).toLocaleTimeString('pt-BR')+'.'):''))
    ]));
  }
  if(q.lastError)box.appendChild(h('div',{className:'field',id:'wa-qr-error',style:'color:var(--err);font-size:.85rem'},'Último erro: '+q.lastError));
  const tog=document.getElementById('tog-wa_qr_enabled');
  if(tog)tog.checked=!!q.enabled;
}
function loadWhatsAppQr(){
  fetch(API+'/system/whatsapp/qr/status',{headers:getHeaders()}).then(r=>r.json()).then(d=>{
    if(d&&!d.error){_waQr=d;if(_activeSettingsTab==='whatsapp')renderWhatsAppQr();}
  }).catch(()=>{});
}
function connectWhatsAppQr(){
  fetch(API+'/system/whatsapp/qr/connect',{method:'POST',headers:getHeaders(),body:'{}'}).then(r=>r.json()).then(d=>{
    if(d&&d.error){showToast('Falha ao conectar: '+d.error,'err');return;}
    if(d)_waQr=d;
    renderWhatsAppQr();
    showToast('Conexão QR solicitada — o código aparece aqui em alguns segundos','ok');
  }).catch(e=>showToast('Falha ao conectar: '+e.message,'err'));
}
function disconnectWhatsAppQr(disable){
  fetch(API+'/system/whatsapp/qr/disconnect',{method:'POST',headers:getHeaders(),body:JSON.stringify(disable?{enabled:false}:{})}).then(r=>r.json()).then(d=>{
    if(d&&d.error){showToast('Falha ao desconectar: '+d.error,'err');return;}
    if(d)_waQr=d;
    renderWhatsAppQr();
  }).catch(e=>showToast('Falha ao desconectar: '+e.message,'err'));
}
function toggleWhatsAppQr(){
  const tog=document.getElementById('tog-wa_qr_enabled');
  if(tog&&tog.checked)connectWhatsAppQr();else disconnectWhatsAppQr(true);
}
// ── Log de conexões (auditoria de eventos dos canais QR/Cloud) ──
const WA_CONN_EVENT_LABELS={service_started:'Serviço iniciado',command_applied:'Comando aplicado',connect_requested:'Conexão solicitada',disconnect_requested:'Desconexão solicitada',qr_generated:'QR gerado',status_changed:'Mudança de status',ready:'Pronto (sessão ativa)',error:'Erro',lock_cleared:'Lock do Chrome removido',send_qr_ok:'Envio via QR ok',send_qr_fail:'Envio via QR falhou',send_cloud_ok:'Envio via Cloud ok',send_cloud_fail:'Envio via Cloud falhou'};
function loadWaConnLog(){
  const box=document.getElementById('wa-conn-log');
  if(!box)return;
  const p=new URLSearchParams({limit:'50',offset:'0'});
  const ch=document.getElementById('wa-conn-channel');
  if(ch&&ch.value)p.set('channel',ch.value);
  fetch(API+'/system/whatsapp/connections/log?'+p.toString(),{headers:getHeaders()}).then(r=>r.json()).then(d=>{
    renderWaConnLog(box,(d&&d.events)||[]);
  }).catch(()=>{
    box.innerHTML='';box.appendChild(h('div',{className:'hint'},'Falha ao carregar o log de conexões.'));
  });
}
function renderWaConnLog(box,events){
  box.innerHTML='';
  if(!events.length){box.appendChild(h('div',{className:'hint'},'Nenhum evento de conexão registrado.'));return;}
  const cellStyle='padding:.35rem .5rem;border-bottom:1px solid var(--border);vertical-align:top;word-break:break-word';
  const table=h('table',{style:'width:100%;border-collapse:collapse;font-size:.85rem;table-layout:fixed'});
  const head=h('tr',{style:'text-align:left;color:var(--muted)'});
  [['Quando','25%'],['Canal','15%'],['Evento','26%'],['Detalhe','34%']].forEach(([t,w])=>head.appendChild(h('th',{style:'padding:.35rem .5rem;border-bottom:1px solid var(--border);width:'+w},t)));
  table.appendChild(head);
  events.forEach(ev=>{
    const tr=h('tr',{});
    const dt=ev.created_at?new Date(ev.created_at).toLocaleString('pt-BR'):'—';
    const isFail=ev.event==='error'||/_fail$/.test(ev.event);
    tr.appendChild(h('td',{style:cellStyle},dt));
    tr.appendChild(h('td',{style:cellStyle},ev.channel==='qr'?'QR':'Cloud'));
    tr.appendChild(h('td',{style:cellStyle+';color:'+(isFail?'var(--err)':'var(--text)')},WA_CONN_EVENT_LABELS[ev.event]||ev.event));
    tr.appendChild(h('td',{style:cellStyle,title:ev.detail||''},ev.detail||'—'));
    table.appendChild(tr);
  });
  box.appendChild(table);
}
// ── Mensagens (auditoria WhatsApp) ──
function renderMessages(el){
  el.innerHTML='';
  const waInputStyle='padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px';
  el.appendChild(h('div',{className:'field',style:'display:flex;gap:.5rem;flex-wrap:wrap;align-items:center'},[
    h('select',{id:'wa-msg-direction',onchange:'loadWhatsAppMessages(true)',style:waInputStyle+';width:auto'},[
      h('option',{value:''},'Todas as direções'),
      h('option',{value:'in'},'↓ Recebidas'),
      h('option',{value:'out'},'↑ Enviadas')
    ]),
    h('select',{id:'wa-msg-kind',onchange:'loadWhatsAppMessages(true)',style:waInputStyle+';width:auto'},[
      h('option',{value:''},'Todos os tipos'),
      h('option',{value:'webhook_in'},'Recebida'),
      h('option',{value:'inbound'},'Recebida (QR)'),
      h('option',{value:'bot_reply'},'Resposta do bot'),
      h('option',{value:'incident_notification'},'Alerta de incidente'),
      h('option',{value:'test_send'},'Teste'),
      h('option',{value:'status_callback'},'Recibo de entrega')
    ]),
    h('select',{id:'wa-msg-status',onchange:'loadWhatsAppMessages(true)',style:waInputStyle+';width:auto'},[
      h('option',{value:''},'Todos os status'),
      h('option',{value:'received'},'Recebida'),
      h('option',{value:'sent'},'Enviada'),
      h('option',{value:'delivered'},'Entregue'),
      h('option',{value:'read'},'Lida'),
      h('option',{value:'failed'},'Falhou')
    ]),
    h('input',{type:'search',id:'wa-msg-q',placeholder:'Buscar telefone ou texto…',oninput:'waMsgSearch()',style:waInputStyle+';flex:1;min-width:180px'}),
    h('button',{className:'btn btn-secondary',type:'button',title:'Atualizar lista',onclick:'loadWhatsAppMessages(true)'},'↺')
  ]));
  el.appendChild(h('div',{id:'wa-messages',style:'overflow-x:auto'},'Carregando…'));
  el.appendChild(h('div',{className:'actions',style:'margin-top:.5rem'},[
    h('button',{className:'btn btn-secondary',type:'button',id:'wa-msg-more',onclick:'loadWhatsAppMessages(false)'},'Carregar mais')
  ]));
  loadWhatsAppMessages(true);
}
const WA_KIND_LABELS={webhook_in:'Recebida',inbound:'Recebida',bot_reply:'Resposta do bot',incident_notification:'Alerta de incidente',test_send:'Teste',status_callback:'Recibo de entrega'};
const WA_STATUS_LABELS={received:'Recebida',sent:'Enviada',failed:'Falhou',delivered:'Entregue',read:'Lida'};
let _waMsgRows=[];let _waMsgOffset=0;let _waMsgTotal=0;let _waMsgSearchTimer=null;let _waReceipts=[];
function waMsgSearch(){clearTimeout(_waMsgSearchTimer);_waMsgSearchTimer=setTimeout(()=>loadWhatsAppMessages(true),400);}
function loadWhatsAppMessages(reset=true){
  const box=document.getElementById('wa-messages');
  if(!box)return;
  if(reset){_waMsgRows=[];_waMsgOffset=0;}
  const p=new URLSearchParams({limit:'20',offset:String(_waMsgOffset)});
  const dir=document.getElementById('wa-msg-direction');
  const kind=document.getElementById('wa-msg-kind');
  const st=document.getElementById('wa-msg-status');
  const q=document.getElementById('wa-msg-q');
  if(dir&&dir.value)p.set('direction',dir.value);
  if(kind&&kind.value)p.set('kind',kind.value);
  if(st&&st.value)p.set('status',st.value);
  if(q&&q.value.trim())p.set('q',q.value.trim());
  fetch(API+'/system/whatsapp/messages?'+p.toString(),{headers:getHeaders()}).then(r=>r.json()).then(d=>{
    const rows=(d&&d.messages)||[];
    if(d&&d.receipts)_waReceipts=d.receipts;
    _waMsgRows=_waMsgRows.concat(rows);
    _waMsgOffset+=rows.length;
    if(rows.length)_waMsgTotal=Number(rows[0].total||0);else if(reset)_waMsgTotal=0;
    renderWhatsAppMessages(box);
  }).catch(()=>{
    if(_waMsgRows.length)return;
    box.innerHTML='';box.appendChild(h('div',{className:'hint'},'Falha ao carregar mensagens.'));
  });
}
function waReceiptsOf(m){
  if(m.direction!=='out'||m.kind==='status_callback'||!m.meta_message_id)return null;
  const rs=_waReceipts.filter(r=>r.meta_message_id===m.meta_message_id);
  if(!rs.length)return null;
  const prio={failed:4,read:3,delivered:2,sent:1};
  return rs.sort((a,b)=>(prio[b.status]||0)-(prio[a.status]||0));
}
function renderWhatsAppMessages(box){
  box.innerHTML='';
  if(!_waMsgRows.length){box.appendChild(h('div',{className:'hint'},'Nenhuma mensagem encontrada.'));}
  else{
    const cellStyle='padding:.35rem .5rem;border-bottom:1px solid var(--border);vertical-align:top';
    const table=h('table',{style:'width:100%;border-collapse:collapse;font-size:.85rem'});
    const head=h('tr',{style:'text-align:left;color:var(--muted)'});
    ['Quando','Tipo','Telefone','Status','Mensagem'].forEach(t=>head.appendChild(h('th',{style:'padding:.35rem .5rem;border-bottom:1px solid var(--border)'},t)));
    table.appendChild(head);
    _waMsgRows.forEach(m=>{
      const tr=h('tr',{});
      const dt=m.created_at?new Date(m.created_at).toLocaleString('pt-BR'):'—';
      const statusCls=m.status==='failed'?'var(--err)':'var(--ok)';
      tr.appendChild(h('td',{style:cellStyle+';white-space:nowrap'},dt));
      tr.appendChild(h('td',{style:cellStyle+';white-space:nowrap'},(m.direction==='in'?'↓ ':'↑ ')+(WA_KIND_LABELS[m.kind]||m.kind)+(m.channel==='qr'?' ·QR':'')));
      tr.appendChild(h('td',{style:cellStyle+';white-space:nowrap'},m.phone||'—'));
      const stTd=h('td',{style:cellStyle});
      const rc=waReceiptsOf(m);
      if(rc){
        const top=rc[0];
        const timeline=rc.slice().sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))
          .map(r=>(WA_STATUS_LABELS[r.status]||r.status)+' — '+new Date(r.created_at).toLocaleString('pt-BR')+(r.error?'\\n'+r.error:'')).join('\\n');
        const tick=top.status==='failed'?'⚠':(top.status==='sent'?'✓':'✓✓');
        const color=top.status==='failed'?'var(--err)':(top.status==='read'?'#53bdeb':'var(--muted)');
        stTd.appendChild(h('span',{style:'color:'+color+';cursor:help',title:timeline},tick+' '+(WA_STATUS_LABELS[top.status]||top.status)));
        if(top.status==='failed'&&top.error)stTd.appendChild(h('div',{style:'color:var(--err);font-size:.75rem'},top.error));
      }else{
        stTd.appendChild(h('span',{style:'color:'+statusCls},WA_STATUS_LABELS[m.status]||m.status));
        if(m.status==='failed'&&m.error)stTd.appendChild(h('div',{style:'color:var(--err);font-size:.75rem'},m.error));
      }
      tr.appendChild(stTd);
      const bodyText=m.body||(m.kind==='status_callback'&&m.meta_message_id?'msg: '+m.meta_message_id:'');
      tr.appendChild(h('td',{style:cellStyle+';max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',title:m.body||m.meta_message_id||''},bodyText));
      table.appendChild(tr);
    });
    box.appendChild(table);
  }
  const more=document.getElementById('wa-msg-more');
  if(more){
    const hasMore=_waMsgOffset<_waMsgTotal;
    more.disabled=!hasMore;
    more.textContent=hasMore?('Carregar mais ('+_waMsgOffset+'/'+_waMsgTotal+')'):('Fim da lista ('+_waMsgTotal+')');
  }
}
function loadWhatsApp(){
  fetch(API+'/system/whatsapp',{headers:getHeaders()}).then(r=>r.json()).then(d=>{
    _whatsapp=(d&&!d.error)?d:{enabled:false,phone_number_id:'',recipient:'',severity_filter:'critical',token_set:false,webhook_verify_token:'',app_secret_set:false,webhook_path:'/observe/api/whatsapp/webhook'};
    if(_activeSettingsTab==='whatsapp') renderWhatsApp(document.getElementById('settings-panel'));
  }).catch(e=>{ if(_activeSettingsTab==='whatsapp') showFeedback('Falha ao carregar WhatsApp: '+e.message,false); });
}
function saveWhatsApp(){
  const body={
    enabled:document.getElementById('tog-wa_enabled').checked,
    phone_number_id:document.getElementById('wa-phone').value.trim(),
    recipient:document.getElementById('wa-recipient').value.trim(),
    severity_filter:document.getElementById('wa-severity').value,
    access_token:document.getElementById('wa-token').value.trim(),
    webhook_verify_token:document.getElementById('wa-verify-token').value.trim(),
    app_secret:document.getElementById('wa-app-secret').value.trim()
  };
  fetch(API+'/system/whatsapp',{method:'PUT',headers:getHeaders(),body:JSON.stringify(body)})
    .then(r=>r.json()).then(d=>{
      if(d.error){showFeedback('Erro: '+d.error,false);showToast('Erro: '+d.error,'err');return;}
      _whatsapp=d;_dirty=false;
      document.getElementById('save-section-btn').disabled=true;
      document.getElementById('dirty-status').textContent='Nenhuma alteração pendente.';
      showToast(d.token_validated?'Token validado e salvo ✓':'Configuração WhatsApp salva','ok');
      renderWhatsApp(document.getElementById('settings-panel'));
      loadStatus(); // atualiza o card de status do WhatsApp
    }).catch(e=>showFeedback('Erro: '+e.message,false));
}
const WA_DEFAULT_TEST_MSG = '✅ R-Observe: notificação WhatsApp configurada com sucesso.';
function closeWhatsAppTestModal(){
  const el=document.getElementById('wa-test-modal');
  if(el)el.remove();
}
function openWhatsAppTestModal(){
  closeWhatsAppTestModal();
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='wa-test-modal';
  const box=document.createElement('div');
  box.className='modal';
  const title=document.createElement('div');
  title.className='modal-title';
  title.textContent='Enviar mensagem de teste';
  const ta=document.createElement('textarea');
  ta.id='wa-test-text';
  ta.className='modal-textarea';
  ta.rows=4;
  ta.value=WA_DEFAULT_TEST_MSG;
  const actions=document.createElement('div');
  actions.className='modal-actions';
  const cancel=document.createElement('button');
  cancel.className='btn btn-secondary';cancel.type='button';cancel.textContent='Cancelar';
  cancel.onclick=closeWhatsAppTestModal;
  const send=document.createElement('button');
  send.className='btn btn-primary';send.type='button';send.id='wa-test-send';send.textContent='Enviar';
  send.onclick=confirmSendWhatsAppTest;
  actions.appendChild(cancel);actions.appendChild(send);
  box.appendChild(title);box.appendChild(ta);box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  ta.focus();ta.select();
}
function confirmSendWhatsAppTest(){
  const ta=document.getElementById('wa-test-text');
  const btn=document.getElementById('wa-test-send');
  const text=(ta?ta.value:'').trim();
  if(!text){showFeedback('Digite uma mensagem para enviar',false);return;}
  if(btn)btn.disabled=true;
  fetch(API+'/system/whatsapp/test',{method:'POST',headers:getHeaders(),body:JSON.stringify({text})})
    .then(r=>r.json()).then(d=>{
      if(d.error){showFeedback('Falha no teste: '+d.error,false);showToast('Falha no teste: '+d.error,'err');loadWhatsAppMessages();}
      else{showFeedback('Mensagem de teste enviada!',true);showToast('Mensagem de teste enviada!','ok');closeWhatsAppTestModal();loadWhatsAppMessages();}
    }).catch(e=>{showFeedback('Falha no teste: '+e.message,false);showToast('Falha no teste: '+e.message,'err');})
    .finally(()=>{if(btn)btn.disabled=false;});
}

// ── AI helpers ──

function getHeaders(){
  const csrf=document.cookie.split('; ').find(value=>value.split('=')[0].endsWith('_csrf'));
  return {
    'Content-Type':'application/json',
    ...(csrf?{'X-CSRF-Token':decodeURIComponent(csrf.split('=').slice(1).join('='))}:{})
  };
}
function selectAIProvider(p){_aiProvider=p;document.querySelectorAll('.provider-btn').forEach(b=>b.classList.toggle('active',b.dataset.provider===p));renderAI(document.getElementById('settings-panel'));markDirty();}
function toggleKey(){const e=document.getElementById('api-key');e.type=e.type==='password'?'text':'password';}
function loadModels(provider,currentModel){
  const sel=document.getElementById('model');sel.innerHTML='<option value="auto">Carregando…</option>';
  fetch(API+'/ai/models?provider='+provider,{headers:getHeaders()}).then(r=>r.json()).then(d=>{
    sel.innerHTML='';const auto=document.createElement('option');auto.value='auto';auto.textContent='Auto ('+(d.auto||'')+')';sel.appendChild(auto);
    (d.models||[]).forEach(m=>{const o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o);});
    sel.value=currentModel||'auto';
    document.getElementById('effective-model').innerHTML='Fonte: '+(d.source==='api'?'API real':'estática');
  }).catch(()=>{sel.innerHTML='<option value="auto">Auto</option>';});
}
function loadAIStatus(){
  fetch(API+'/ai/settings',{headers:getHeaders()}).then(r=>r.json()).then(d=>{
    _aiProvider=d.provider||'mock';_aiModel=d.model||'auto';_aiLoaded=true;
    const btn=document.getElementById('save-ai-btn');
    if(btn) btn.disabled=false;
    if(_activeSettingsTab==='ai') renderAI(document.getElementById('settings-panel'));
  }).catch(()=>{});
}
async function saveAISettings(){
  const body={provider:_aiProvider,model:document.getElementById('model')?.value||'auto'};
  const key=document.getElementById('api-key')?.value;
  if(key)body.api_key=key;
  const r=await fetch(API+'/ai/settings',{method:'POST',headers:getHeaders(),body:JSON.stringify(body)});
  const d=await r.json();
  showFeedback(d.ok?'IA configurada com sucesso':'Erro: '+(d.error||'desconhecido'),d.ok);
  if(d.ok){_dirty=false;loadAIStatus();}
}

// ── Status ──
function loadStatus(){
  fetch(API+'/system/status',{headers:getHeaders()}).then(async r=>{
    if(r.status===401){location.href='/observe/login?next=/observe/settings';throw new Error('Sessão expirada');}
    if(!r.ok)throw new Error('Status indisponível ('+r.status+')');
    return r.json();
  }).then(d=>{
    const ai=d.ai||{};const ag=d.agents||{};const disc=d.discovery||{};const s=d.settings||{};
    const aiCls = s.ai?.key_status==='ok' ? 'ok' : (s.ai?.key_status==='invalid' ? 'err' : 'warn');
    const stAi = document.getElementById('st-ai');
    stAi.textContent = s.ai?.provider||'—';
    const aiCard = stAi.closest('.status-card');
    if (aiCard) aiCard.className = 'status-card ' + aiCls;
    document.getElementById('st-agents').textContent=(ag.online||0)+'/'+(ag.total||0);
    document.getElementById('st-assets').textContent=disc.total_assets||0;
    const wa=d.whatsapp||{};
    const stWa=document.getElementById('st-whatsapp');
    if(stWa){
      const waReady=!!(wa.enabled&&wa.token_set&&wa.phone_number_id&&wa.recipient);
      let waText='—',waCls='warn';
      if(!wa.enabled){waText='Inativo';waCls='warn';}
      else if(wa.token_status==='invalid'){waText='Token inválido';waCls='err';}
      else if(waReady){waText='Ativo';waCls='ok';}
      else{waText='Incompleto';waCls='warn';}
      stWa.textContent=waText;
      const waCard=stWa.closest('.status-card');
      if(waCard)waCard.className='status-card '+waCls;
    }
    document.getElementById('sv-ai').textContent=s.ai?.provider||'—';
    document.getElementById('sd-ai').className='dot '+aiCls;
    document.getElementById('sv-agents').textContent=((ag.total||0)===0)?'0 registrados':((ag.online||0)+' online, '+(ag.offline||0)+' offline');
    document.getElementById('sd-agents').className='dot '+(ag.offline>0?'err':(ag.online>0?'ok':'warn'));
    document.getElementById('sv-assets').textContent=(disc.total_assets||0)+' ativos';
    document.getElementById('sv-ports').textContent=s.discovery?.port_change_detection?'Ativo':'Inativo';
    document.getElementById('sd-ports').className='dot '+(s.discovery?.port_change_detection?'ok':'warn');
    document.getElementById('sv-certs').textContent='warning '+s.certs?.expiry_warning_days+'d, crit '+s.certs?.expiry_critical_days+'d';
    _allSettings=s;
    if(!_settingsReady){
      _settingsReady=true;
      document.querySelectorAll('.tab-btn').forEach(button=>button.disabled=false);
      switchTab(_activeSettingsTab||'discovery');
    }
  }).catch(e=>{
    if(e.message==='Sessão expirada')return;
    showFeedback('Não foi possível carregar a configuração real: '+e.message,false);
  });
}

function logout(){fetch(API+'/auth/logout',{method:'POST',headers:getHeaders()}).finally(()=>location.href='/observe/login');}

// Init
_activeSettingsTab='discovery';
document.querySelectorAll('.tab-btn').forEach(button=>button.disabled=true);
document.getElementById('settings-panel').innerHTML='<div class="loading-state" role="status">Carregando configuração real…</div>';
loadStatus();
setInterval(loadStatus,30000);
// Auto-refresh da auditoria de mensagens quando a aba Mensagens está aberta.
setInterval(()=>{if(_activeSettingsTab==='messages'&&document.getElementById('wa-messages'))loadWhatsAppMessages(true);},30000);
// Canal QR: enquanto aguarda o pareamento, atualiza status/QR a cada 5s.
setInterval(()=>{if(_activeSettingsTab==='whatsapp'&&document.getElementById('wa-qr-box')&&_waQr&&_waQr.status==='pairing')loadWhatsAppQr();},5000);
setInterval(()=>{if(_activeSettingsTab==='whatsapp'&&document.getElementById('wa-conn-log'))loadWaConnLog();},5000);
loadWhatsApp();
loadAIStatus();
</script>
</body>
</html>`;

const VERSIONS_HTML = /* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Results · R-Observe · Versões da Stack</title>
  <style>
    :root {
      --bg: #07080c;
      --surface: rgba(255, 255, 255, 0.03);
      --card: rgba(18, 20, 28, 0.72);
      --text: #e7e9ef;
      --muted: #8b90a0;
      --border: rgba(255, 255, 255, 0.08);
      --brand: #ef4444;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1100px 520px at 12% -8%, rgba(239, 68, 68, 0.20), transparent 60%),
        radial-gradient(900px 480px at 88% -4%, rgba(99, 102, 241, 0.18), transparent 60%),
        radial-gradient(700px 420px at 50% 110%, rgba(34, 211, 238, 0.10), transparent 60%),
        var(--bg);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Topbar ─────────────────────────────────────────────────────────── */
    .topbar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; gap: 12px;
      padding: 12px 28px;
      background: rgba(10, 11, 16, 0.7);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--border);
    }
    .topbar .logo {
      width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
      background: linear-gradient(135deg, #ef4444, #b91c1c);
      display: grid; place-items: center;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4);
    }
    .topbar .logo svg { width: 18px; height: 18px; }
    .topbar-brand { font-size: .72rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--brand); }
    .topbar-title { font-size: .84rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .topbar-nav { margin-left: auto; display: flex; gap: 6px; align-items: center; }
    .topbar-link {
      color: var(--muted); text-decoration: none; font-size: .82rem;
      padding: 7px 12px; border-radius: 9px; transition: color .15s ease, background .15s ease;
    }
    .topbar-link:hover { color: var(--text); background: rgba(255, 255, 255, 0.06); }
    .topbar-link.active { color: #fff; background: rgba(239, 68, 68, 0.16); border: 1px solid rgba(239, 68, 68, 0.35); }
    .topbar-link.logout { border: 1px solid var(--border); background: transparent; cursor: pointer; }

    /* ── Layout ─────────────────────────────────────────────────────────── */
    .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px 48px; }
    .hero { text-align: center; padding: 56px 0 30px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: .72rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
      color: var(--muted); background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border); border-radius: 999px; padding: 7px 14px; margin-bottom: 20px;
    }
    .eyebrow .dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 10px #34d399; }
    .hero h1 { margin: 0; font-size: clamp(2rem, 4.4vw, 3rem); font-weight: 800; letter-spacing: -0.03em; line-height: 1.05; }
    .hero h1 .grad {
      background: linear-gradient(100deg, #f87171, #fbbf24 55%, #34d399);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .lead { margin: 14px auto 0; max-width: 560px; color: var(--muted); font-size: .98rem; line-height: 1.6; }

    .stats { display: flex; justify-content: center; gap: 12px; margin-top: 26px; flex-wrap: wrap; }
    .stat {
      background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
      padding: 14px 22px; min-width: 128px; backdrop-filter: blur(8px);
      transition: transform .16s ease, border-color .16s ease;
    }
    .stat:hover { transform: translateY(-2px); border-color: rgba(255, 255, 255, 0.18); }
    .stat .n { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
    .stat .l { font-size: .7rem; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-top: 2px; }
    .updated { margin-top: 16px; font-size: .8rem; color: var(--muted); }

    .refresh {
      margin-top: 18px; display: inline-flex; align-items: center; gap: 7px;
      font-size: .83rem; font-weight: 600; color: var(--text);
      background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border);
      border-radius: 10px; padding: 9px 16px; cursor: pointer; transition: all .15s ease;
    }
    .refresh:hover { background: rgba(255, 255, 255, 0.09); border-color: rgba(255, 255, 255, 0.2); }

    /* ── Groups grid ────────────────────────────────────────────────────── */
    .groups {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px;
      margin-top: 28px;
    }
    @media (max-width: 780px) { .groups { grid-template-columns: 1fr; } }

    .group-card {
      position: relative; overflow: hidden;
      background: var(--card); border: 1px solid var(--border); border-radius: 18px;
      padding: 22px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
      animation: rise .4s ease both;
    }
    .group-card:nth-child(2) { animation-delay: .05s; }
    .group-card:nth-child(3) { animation-delay: .1s; }
    .group-card:nth-child(4) { animation-delay: .15s; }
    .group-card::before {
      content: ""; position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, var(--accent), transparent 70%);
    }
    .group-card:hover {
      transform: translateY(-4px);
      border-color: color-mix(in srgb, var(--accent) 45%, transparent);
      box-shadow: 0 22px 48px -24px var(--accent-glow);
    }
    .g-core       { --accent: #818cf8; --accent-bg: rgba(129, 140, 248, .14); --accent-glow: rgba(129, 140, 248, .45); }
    .g-monitoring { --accent: #34d399; --accent-bg: rgba(52, 211, 153, .14); --accent-glow: rgba(52, 211, 153, .45); }
    .g-icinga     { --accent: #fbbf24; --accent-bg: rgba(251, 191, 36, .14); --accent-glow: rgba(251, 191, 36, .45); }
    .g-data       { --accent: #22d3ee; --accent-bg: rgba(34, 211, 238, .14); --accent-glow: rgba(34, 211, 238, .45); }

    .group-head { display: flex; align-items: center; gap: 13px; margin-bottom: 14px; }
    .group-icon {
      width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
      display: grid; place-items: center; font-size: 20px;
      background: var(--accent-bg);
    }
    .group-meta h2 { margin: 0; font-size: 1rem; font-weight: 700; letter-spacing: -0.01em; }
    .group-meta span { font-size: .74rem; color: var(--muted); }

    .components { list-style: none; margin: 0; padding: 0; }
    .components li {
      display: flex; justify-content: space-between; align-items: center; gap: 10px;
      padding: 11px 2px; border-bottom: 1px solid var(--border);
    }
    .components li:last-child { border-bottom: none; padding-bottom: 0; }
    .c-name { font-size: .9rem; color: var(--text); }
    .c-ver {
      font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: .76rem; color: #cbd5e1;
      background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border);
      padding: 4px 11px; border-radius: 999px; white-space: nowrap;
    }

    .loading, .error { text-align: center; padding: 4rem 1rem; color: var(--muted); }
    .error { color: #f87171; }
    .foot { text-align: center; padding: 32px 0 8px; font-size: .76rem; color: var(--muted); }

    @keyframes rise {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
<header class="topbar">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-4Z" fill="#fff" opacity=".95"/><path d="m9 12 2 2 4-4" stroke="#ef4444" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
  <span class="topbar-brand">Results · Sistemas de Informática</span>
  <span class="topbar-title">/ R-Observe · Versões da Stack</span>
  <nav class="topbar-nav">
    <a href="/observe/home" class="topbar-link">⌂ Home</a>
    <a href="/icinga/" class="topbar-link">🔍 Icinga</a>
    <a href="/observe/settings" class="topbar-link">⚙ Config</a>
    <a href="/observe/versions" class="topbar-link active">ⓘ Versões</a>
    <button class="topbar-link logout" onclick="logout()">Sair</button>
  </nav>
</header>

<main class="wrap">
  <section class="hero">
    <div class="eyebrow"><span class="dot"></span> Stack ativa</div>
    <h1>Versões da <span class="grad">Stack</span></h1>
    <p class="lead" id="stack-sub">Inventário de componentes e versões do ambiente de observabilidade.</p>
    <div class="stats">
      <div class="stat"><div class="n" id="stat-components">—</div><div class="l">Componentes</div></div>
      <div class="stat"><div class="n" id="stat-groups">—</div><div class="l">Grupos</div></div>
      <div class="stat"><div class="n" id="stat-version">—</div><div class="l">Versão</div></div>
    </div>
    <p class="updated" id="stack-updated"></p>
    <button class="refresh" onclick="load()">↺ Atualizar</button>
  </section>

  <section class="groups" id="content">
    <div class="loading">Carregando versões…</div>
  </section>

  <footer class="foot">R-Observe · Results Sistemas de Informática</footer>
</main>

<script>
var GROUP_META = {
  core:       { icon: '🧩', cls: 'g-core' },
  monitoring: { icon: '📈', cls: 'g-monitoring' },
  icinga:     { icon: '🛡️', cls: 'g-icinga' },
  data:       { icon: '🗄️', cls: 'g-data' },
};
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function csrfHeaders(){
  var csrf = document.cookie.split('; ').find(function(v){ return v.split('=')[0].endsWith('_csrf'); });
  return csrf ? { 'Content-Type':'application/json', 'X-CSRF-Token': decodeURIComponent(csrf.split('=').slice(1).join('=')) } : { 'Content-Type':'application/json' };
}
function logout(){ fetch('/observe/api/auth/logout',{method:'POST',headers:csrfHeaders()}).finally(function(){ location.href='/observe/login'; }); }
function load(){
  fetch('/observe/api/system/versions',{headers:{'Accept':'application/json'}})
    .then(function(r){ if(r.status===401){ location.href='/observe/login?next=/observe/versions'; throw new Error('Sessão expirada'); } if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(d){
      var groups = d.groups || [];
      var total = 0;
      groups.forEach(function(g){ total += (g.components || []).length; });
      document.getElementById('stat-components').textContent = total;
      document.getElementById('stat-groups').textContent = groups.length;
      document.getElementById('stat-version').textContent = 'v' + d.version;
      document.getElementById('stack-sub').textContent = 'Stack ' + esc(d.stack) + ' · ' + total + ' componentes em ' + groups.length + ' grupos.';
      document.getElementById('stack-updated').textContent = 'Atualizado em ' + new Date(d.generated_at).toLocaleString('pt-BR');
      var h = '';
      groups.forEach(function(g){
        var meta = GROUP_META[g.id] || { icon: '📦', cls: 'g-core' };
        var comps = g.components || [];
        h += '<article class="group-card ' + meta.cls + '">';
        h += '<header class="group-head"><div class="group-icon">' + meta.icon + '</div>';
        h += '<div class="group-meta"><h2>' + esc(g.label) + '</h2><span>' + comps.length + ' componentes</span></div></header>';
        h += '<ul class="components">';
        comps.forEach(function(c){
          h += '<li><span class="c-name">' + esc(c.name) + '</span><span class="c-ver">' + esc(c.version) + '</span></li>';
        });
        h += '</ul></article>';
      });
      document.getElementById('content').innerHTML = h || '<div class="error">Nenhuma informação de versão disponível.</div>';
    })
    .catch(function(e){ document.getElementById('content').innerHTML='<div class="error">' + esc(e.message) + '</div>'; });
}
load();
</script>
</body>
</html>`;
