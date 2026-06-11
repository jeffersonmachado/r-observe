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
const { v4: uuidv4 } = require('uuid');
const icinga = require('./icinga');
const { createDbClient } = require('./db');
const { signInternalToken, verifyInternalToken } = require('./jwt');
const { createAuthMiddleware } = require('./middleware/auth');
const { createAISettingsService } = require('./services/ai-settings');
const { createLifecycle } = require('../shared/lifecycle');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE = process.env.BASE_PATH || '/observe/api';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SESSION_COOKIE = process.env.OBSERVE_SESSION_COOKIE || 'observe_session';
const SESSION_TTL_HOURS = parseInt(process.env.OBSERVE_SESSION_TTL_HOURS || '12', 10);
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
const { VALID_AI_PROVIDERS, AI_AUTO_MODELS, AI_STATIC_MODELS } = require('../shared/ai-models');

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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-internal-token'],
}));
app.use(express.json({ limit: '512kb' }));

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
  requireAuth,
  requireRole,
  requireAdmin,
  parseCookies,
  sessionHash,
  setSessionCookie,
  clearSessionCookie,
  getContactRole,
  authenticateRequest,
} = createAuthMiddleware(db, SESSION_COOKIE, log);

// ─── Rate limiters ────────────────────────────────────────────────────────────
const RL_WINDOW = parseInt(process.env.OBSERVE_RATE_LIMIT_WINDOW_MS || '60000', 10);
const eventLimiter = rateLimit({ windowMs: RL_WINDOW, max: parseInt(process.env.OBSERVE_RATE_LIMIT_EVENTS_MAX || '100', 10), standardHeaders: true, legacyHeaders: false });
const apiLimiter  = rateLimit({ windowMs: RL_WINDOW, max: parseInt(process.env.OBSERVE_RATE_LIMIT_API_MAX || '300', 10), standardHeaders: true, legacyHeaders: false });

// ─── Auth endpoints ─────────────────────────────────────────────────────────
app.post(`${BASE}/auth/login`, apiLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });

  try {
    const r = await db.query(`
      SELECT "name", "active"
      FROM icingaweb_user
      WHERE lower("name") = lower($1::text)
        AND "active" = 1
        AND "password_hash" = convert_to(crypt($2::text, convert_from("password_hash", 'UTF8')), 'UTF8')
      LIMIT 1
    `, [username, password]);
    if (!r.rowCount) return res.status(401).json({ error: 'Credenciais inválidas' });

    const user = r.rows[0].name;
    const role = await getContactRole(user);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

    await db.query(`
      INSERT INTO observe_sessions (token_hash, username, role, user_agent, ip, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      sessionHash(token),
      user,
      role,
      String(req.headers['user-agent'] || '').slice(0, 512),
      req.ip || req.socket?.remoteAddress || null,
      expiresAt,
    ]);

    setSessionCookie(req, res, token, expiresAt);
    res.json({ ok: true, user: { name: user, role }, expires_at: expiresAt.toISOString() });
  } catch (e) {
    log('warn', 'Login failed', { user: username, err: e.message });
    res.status(500).json({ error: 'Falha ao autenticar' });
  }
});

app.post(`${BASE}/auth/logout`, requireAuth, async (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    await db.query(`DELETE FROM observe_sessions WHERE token_hash = $1`, [sessionHash(token)]).catch(() => {});
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get(`${BASE}/auth/me`, requireAuth, async (req, res) => {
  res.json({ user: { name: req.auth.user, role: req.auth.role, auth_type: req.auth.type } });
});

// ─── Serviços (extraídos para services/) ─────────────────────────────────────
const {
  proxyToAI,
  aiProxyFailureExtra,
  proxyToDiscovery,
  getPersistedAISettings,
  upsertPersistedAISettings,
  applyPersistedAISettingsOnStartup,
  reconcilePersistedAISettings,
} = createAISettingsService({ db, log, logAIReconcileIssue, processEnv: process.env });

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get(`${BASE}/health`, (_req, res) => {
  res.json({ status: 'ok', service: 'r-observe-api', version: '0.1.0' });
});

// Prometheus metrics
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

app.post(`${BASE}/contacts`, requireAuth, requireAdmin, async (req, res) => {
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
      VALUES ($1::varchar, $2::smallint, convert_to(crypt($3::text, gen_salt('bf')), 'UTF8'), NOW(), NOW())
    `, [username, active === false ? 0 : 1, String(password)]);
    await setContactAdmin(username, admin === true);
    res.status(201).json({ contact: { name: username, active: active === false ? 0 : 1, admin: admin === true } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch(`${BASE}/contacts/:name`, requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.params.name || '').trim();
  const { password, active, admin } = req.body || {};
  try {
    const updates = [];
    const vals = [];
    let i = 1;
    if (active !== undefined) { updates.push(`"active" = $${i++}::smallint`); vals.push(active === false ? 0 : 1); }
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: 'password deve ter pelo menos 8 caracteres' });
      updates.push(`"password_hash" = convert_to(crypt($${i++}::text, gen_salt('bf')), 'UTF8')`);
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
app.post(`${BASE}/hosts`, requireAuth, requireAdmin, async (req, res) => {
  const { name, address, display_name, vars } = req.body;
  if (!name || !address) return res.status(400).json({ error: '"name" e "address" são obrigatórios' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
    return res.status(400).json({ error: 'name inválido (use apenas letras, números, hífens, pontos)' });
  try {
    // Upsert no banco
    const r = await db.query(
      `INSERT INTO observe_hosts (id, name, address, metadata, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (name)
       DO UPDATE SET address = EXCLUDED.address, metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [uuidv4(), name, address, JSON.stringify({ source: 'manual', display_name, vars })]
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
app.post(`${BASE}/inventory/docker`, requireAuth, requireAdmin, async (req, res) => {
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
       ON CONFLICT (name)
       DO UPDATE SET address = EXCLUDED.address,
                     status = 'up',
                     last_check = NOW(),
                     metadata = EXCLUDED.metadata,
                     updated_at = NOW()
       RETURNING id`,
      [uuidv4(), hostName, address || null, JSON.stringify({
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
         ON CONFLICT (host_id, name)
         DO UPDATE SET status = EXCLUDED.status,
                       last_check = NOW(),
                       output = EXCLUDED.output,
                       metadata = EXCLUDED.metadata,
                       updated_at = NOW()`,
        [
          uuidv4(),
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
app.delete(`${BASE}/hosts/:name`, requireAuth, requireAdmin, async (req, res) => {
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
app.post(`${BASE}/hosts/scan`, requireAuth, requireAdmin, async (req, res) => {
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

app.get('/observe/discovery', async (req, res) => {
  // Verifica sessao manualmente e redireciona para login se ausente
  try {
    const auth = await authenticateRequest(req);
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

app.post(`${BASE}/discovery/policies`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery('/api/discovery/policies', { method: 'POST', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});

app.post(`${BASE}/discovery/scan`, requireAuth, requireAdmin, async (req, res) => {
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
app.patch(`${BASE}/discovery/policies/:id`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/policies/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.delete(`${BASE}/discovery/policies/:id`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/policies/${req.params.id}`, { method: 'DELETE' });
  res.status(out.status).json(out.data);
});

// Targets — CRUD completo
app.get(`${BASE}/discovery/targets`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/targets${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});
app.post(`${BASE}/discovery/targets`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery('/api/discovery/targets', { method: 'POST', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.patch(`${BASE}/discovery/targets/:id`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/targets/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.delete(`${BASE}/discovery/targets/:id`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/targets/${req.params.id}`, { method: 'DELETE' });
  res.status(out.status).json(out.data);
});

// Assets — atualizar ciclo de vida
app.patch(`${BASE}/discovery/assets/:id`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/assets/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});

// ── Enterprise: Schedules, Quotas, Audit ────────────────────────────────────
app.get(`${BASE}/discovery/schedules`, requireAuth, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/schedules${discoveryQuery(req)}`);
  res.status(out.status).json(out.data);
});
app.post(`${BASE}/discovery/schedules`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery('/api/discovery/schedules', { method: 'POST', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.patch(`${BASE}/discovery/schedules/:id`, requireAuth, requireAdmin, async (req, res) => {
  const out = await proxyToDiscovery(`/api/discovery/schedules/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
  res.status(out.status).json(out.data);
});
app.delete(`${BASE}/discovery/schedules/:id`, requireAuth, requireAdmin, async (req, res) => {
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
app.post(`${BASE}/events`, requireAuth, eventLimiter, async (req, res) => {
  const event = req.body;
  if (!event || !event.type) return res.status(400).json({ error: 'event.type is required' });
  try {
    eventsReceivedTotal.inc({ source: event.source || 'generic' });
    if (redis) await redis.rpush('observe:events', JSON.stringify({ ...event, receivedAt: new Date().toISOString() }));
    res.status(202).json({ accepted: true, id: uuidv4() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Icinga events
app.post(`${BASE}/icinga/events`, requireAuth, eventLimiter, async (req, res) => {
  const event = req.body;
  if (!event) return res.status(400).json({ error: 'Body obrigatório' });
  try {
    eventsReceivedTotal.inc({ source: 'icinga' });
    const payload = JSON.stringify({ ...event, source: 'icinga', receivedAt: new Date().toISOString() });
    if (redis) await redis.rpush('observe:events:icinga', payload);
    res.status(202).json({ accepted: true, id: uuidv4() });
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
  },
  agents: {
    offline_threshold_minutes: Math.round(parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10) / 60000),
    offline_check_enabled: process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false',
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

let _systemSettings = { ...SYSTEM_SETTINGS_DEFAULTS };
let _settingsLoaded = false;

function loadSystemSettings() {
  // Recarrega dos env vars (runtime)
  _systemSettings = {
    discovery: {
      scan_interval_minutes: parseInt(process.env.DISCOVERY_SCAN_INTERVAL_MINUTES || '60', 10),
      arp_enabled: process.env.DISCOVERY_ARP_ENABLED !== 'false',
      docker_enabled: process.env.DISCOVERY_DOCKER_ENABLED === 'true',
      cloud_enabled: process.env.DISCOVERY_CLOUD_AWS_ENABLED === 'true',
      passive_enabled: process.env.DISCOVERY_PASSIVE_LISTENERS_ENABLED !== 'false',
      port_change_detection: process.env.DISCOVERY_PORT_CHANGE_DETECTION !== 'false',
      port_disappeared_grace_scans: parseInt(process.env.DISCOVERY_PORT_DISAPPEARED_GRACE || '2', 10),
    },
    agents: {
      offline_threshold_minutes: Math.round(parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10) / 60000),
      offline_check_enabled: process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false',
    },
    certs: { ..._systemSettings.certs },
    os_defaults: { ..._systemSettings.os_defaults },
    ai: {
      provider: process.env.AI_PROVIDER || 'mock',
      model: process.env.AI_MODEL || 'auto',
      auto_threshold: parseFloat(process.env.REMEDIATION_AUTO_THRESHOLD || '0.85'),
      max_auto_severity: process.env.REMEDIATION_MAX_AUTO_SEVERITY || 'warning',
    },
    monitoring: { ..._systemSettings.monitoring },
  };
  _settingsLoaded = true;
  return _systemSettings;
}

app.get(`${BASE}/system/settings`, requireAuth, (_req, res) => {
  if (!_settingsLoaded) loadSystemSettings();
  res.json({
    ..._systemSettings,
    _meta: {
      ai_provider_active: _systemSettings.ai.provider,
      discovery_port_change_active: _systemSettings.discovery.port_change_detection,
      agent_offline_active: _systemSettings.agents.offline_check_enabled,
      cert_expiry_warning_days: _systemSettings.certs.expiry_warning_days,
    },
  });
});

app.post(`${BASE}/system/settings`, requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};

  // Atualiza apenas os campos enviados
  if (body.discovery) {
    if (typeof body.discovery.port_change_detection === 'boolean')
      _systemSettings.discovery.port_change_detection = body.discovery.port_change_detection;
    if (typeof body.discovery.port_disappeared_grace_scans === 'number')
      _systemSettings.discovery.port_disappeared_grace_scans = body.discovery.port_disappeared_grace_scans;
  }
  if (body.agents) {
    if (typeof body.agents.offline_check_enabled === 'boolean')
      _systemSettings.agents.offline_check_enabled = body.agents.offline_check_enabled;
    if (typeof body.agents.offline_threshold_minutes === 'number')
      _systemSettings.agents.offline_threshold_minutes = body.agents.offline_threshold_minutes;
  }
  if (body.certs) {
    if (typeof body.certs.expiry_warning_days === 'number')
      _systemSettings.certs.expiry_warning_days = body.certs.expiry_warning_days;
    if (typeof body.certs.expiry_critical_days === 'number')
      _systemSettings.certs.expiry_critical_days = body.certs.expiry_critical_days;
  }
  if (body.os_defaults) {
    if (typeof body.os_defaults.linux_node_exporter === 'boolean')
      _systemSettings.os_defaults.linux_node_exporter = body.os_defaults.linux_node_exporter;
    if (typeof body.os_defaults.windows_exporter === 'boolean')
      _systemSettings.os_defaults.windows_exporter = body.os_defaults.windows_exporter;
    if (typeof body.os_defaults.network_snmp === 'boolean')
      _systemSettings.os_defaults.network_snmp = body.os_defaults.network_snmp;
  }
  if (body.ai) {
    if (typeof body.ai.auto_threshold === 'number')
      _systemSettings.ai.auto_threshold = body.ai.auto_threshold;
    if (typeof body.ai.max_auto_severity === 'string')
      _systemSettings.ai.max_auto_severity = body.ai.max_auto_severity;
  }

  log('info', 'System settings updated', { changed: Object.keys(body) });
  res.json({ ok: true, settings: _systemSettings });
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
      settings: _settingsLoaded ? _systemSettings : loadSystemSettings(),
    });
  } catch (e) {
    res.json({ error: e.message });
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
app.post(`${BASE}/ai/settings`, requireAuth, requireAdmin, async (req, res) => {
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

// Remediation request (manual)
app.post(`${BASE}/remediation/request`, requireAuth, requireAdmin, async (req, res) => {
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
app.post(`${BASE}/remediation/:id/approve`, requireAuth, requireAdmin, async (req, res) => {
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
app.post(`${BASE}/remediation/:id/reject`, requireAuth, requireAdmin, async (req, res) => {
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

app.post(`${BASE}/ai/catalog`, requireAuth, requireAdmin, async (req, res) => {
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

app.patch(`${BASE}/ai/catalog/:action`, requireAuth, requireAdmin, async (req, res) => {
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

app.delete(`${BASE}/ai/catalog/:action`, requireAuth, requireAdmin, async (req, res) => {
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
app.get('/observe/login', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(LOGIN_HTML);
});

// ─── UI: página de configuração do provider de IA ─────────────────────────────
app.get('/observe/settings', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(SETTINGS_HTML);
});

// ─── UI: home com atalhos das interfaces ────────────────────────────────────
app.get('/observe/home', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(HOME_HTML);
});

// ─── UI: dashboard de atividade da IA ─────────────────────────────────────────
app.get('/observe/ai', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(AI_DASHBOARD_HTML);
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  log('error', 'Unhandled error', { err: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const { runMigrations } = require('./migrate');
const { bootstrapInitialUsers } = require('./bootstrap');

(async () => {
  try {
    await runMigrations(db);
    await bootstrapInitialUsers(db, process.env, { log: (line) => process.stdout.write(line + '\n') });
    await applyPersistedAISettingsOnStartup();

    const timer = setInterval(() => {
      reconcilePersistedAISettings('interval').catch((e) => {
        log(AI_SETTINGS_RECONCILE_STRICT ? 'error' : 'debug', 'Periodic AI settings reconcile failed', { err: e.message });
        if (AI_SETTINGS_RECONCILE_STRICT) process.exit(1);
      });
    }, AI_SETTINGS_RECONCILE_INTERVAL_MS);
    timer.unref();
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
    <input id="username" name="username" autocomplete="username" autofocus>
    <label for="password">Senha</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <button id="submit" type="submit">Entrar</button>
    <div id="error" class="error"></div>
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
  </div>
</div>
<div class="header-controls">
  <button class="btn btn-primary btn-sm" onclick="loadAll()" style="flex-shrink:0">↺ Atualizar</button>
  <button class="btn btn-sm" onclick="logout()" style="flex-shrink:0">Sair</button>
  <span id="last-refresh" style="color:var(--muted);font-size:.75rem;margin-left:.25rem"></span>
</div>

<nav role="tablist">
  <button class="tab active" role="tab" aria-selected="true"  onclick="showTab('overview')">Visão Geral</button>
  <button class="tab" role="tab" aria-selected="false" onclick="showTab('analyses')">Análises</button>
  <button class="tab" role="tab" aria-selected="false" onclick="showTab('catalog')">Catálogo</button>
  <button class="tab" role="tab" aria-selected="false" onclick="showTab('remediations')">Remediações</button>
  <button class="tab" role="tab" aria-selected="false" onclick="showTab('contacts')">Contatos</button>
</nav>

<div id="overview" class="page active">
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

<div id="analyses" class="page">
  <div class="section-title">Todas as Análises <span style="font-weight:400;color:var(--muted);font-size:.8rem">— últimas 20</span></div>
  <div class="table-wrap">
  <table id="analyses-table">
    <thead><tr><th>Título</th><th>Host</th><th>Causa</th><th>Sugestão</th><th>Feedback</th></tr></thead>
    <tbody><tr><td colspan="5" class="empty">Carregando dados.</td></tr></tbody>
  </table>
  </div>
</div>

<div id="catalog" class="page">
  <div class="section-title">Catálogo de Remediações</div>
  <div class="table-wrap">
  <table id="catalog-table">
    <thead><tr><th>Ação</th><th>Descrição</th><th>Risco</th><th>Auto</th><th>Max Sev.</th><th>Status</th><th></th></tr></thead>
    <tbody><tr><td colspan="7" class="empty">Carregando dados.</td></tr></tbody>
  </table>
  </div>
</div>

<div id="remediations" class="page">
  <div class="section-title">Remediações Recentes <span style="font-weight:400;color:var(--muted);font-size:.8rem">— últimas 20</span></div>
  <div class="table-wrap">
  <table id="rem-table">
    <thead><tr><th>Ação</th><th>Status</th><th>Score</th><th>Auto</th><th>Output</th><th>Data</th></tr></thead>
    <tbody><tr><td colspan="6" class="empty">Carregando dados.</td></tr></tbody>
  </table>
  </div>
</div>

<div id="contacts" class="page">
  <div class="section-title">Contatos Operacionais</div>
  <div style="display:grid;grid-template-columns:minmax(220px,320px) 1fr;gap:14px;align-items:start">
    <form onsubmit="createContact(event)" style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:12px">
      <div style="font-weight:700;margin-bottom:10px">Novo contato</div>
      <label style="display:block;color:var(--muted);font-size:.8rem;margin-bottom:4px">Usuário</label>
      <input id="contact-name" style="width:100%;margin-bottom:8px" placeholder="operador@results">
      <label style="display:block;color:var(--muted);font-size:.8rem;margin-bottom:4px">Senha inicial</label>
      <input id="contact-password" type="password" style="width:100%;margin-bottom:8px" placeholder="mínimo 8 caracteres">
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

<div id="toast"></div>

<script>
const API = '/observe/api';
let _data = {};

function getHeaders() {
  return { 'Content-Type': 'application/json' };
}

function redirectLogin() {
  location.href = '/observe/login?next=' + encodeURIComponent(location.pathname);
}

async function logout() {
  await fetch(API + '/auth/logout', { method: 'POST', headers: getHeaders() }).catch(() => {});
  location.href = '/observe/login?next=/observe/ai';
}

function showTab(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  document.getElementById(id).classList.add('active');
  const activeTab = document.querySelector('[onclick="showTab(\\''+id+'\\')"]');
  activeTab.classList.add('active');
  activeTab.setAttribute('aria-selected', 'true');
}

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
      '<button class="btn btn-sm" style="background:#1a7f3733;color:var(--green)" onclick="sendFeedback(\\''+r.id+'\\',1)">👍</button>' +
      '<button class="btn btn-sm" style="background:#da363333;color:var(--red)"   onclick="sendFeedback(\\''+r.id+'\\',-1)">👎</button>' +
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
    <button class="topbar-link" onclick="logout()" style="border:1px solid var(--border);background:transparent;cursor:pointer">Sair</button>
  </div>
</div>
<div class="settings-page">

  <!-- Status Cards -->
  <div class="status-cards" id="status-cards">
    <div class="status-card ok"><div class="card-value" id="st-ai">—</div><div class="card-label">IA Provider</div></div>
    <div class="status-card ok"><div class="card-value" id="st-agents">0/0</div><div class="card-label">Agentes Online</div></div>
    <div class="status-card ok"><div class="card-value" id="st-assets">0</div><div class="card-label">Ativos Monitorados</div></div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('discovery')">🔍 Descoberta</button>
    <button class="tab-btn" onclick="switchTab('ai')">🤖 IA</button>
    <button class="tab-btn" onclick="switchTab('agents')">📡 Agentes</button>
    <button class="tab-btn" onclick="switchTab('os')">💻 SO</button>
    <button class="tab-btn" onclick="switchTab('certs')">🔒 Certs</button>
  </div>

  <div class="settings-layout">
    <div class="settings-panel" id="settings-panel">
      <!-- Content rendered dynamically by switchTab() -->
    </div>

    <div class="settings-aside">
      <div class="aside-panel">
        <div class="panel-title">Status ao Vivo</div>
        <div class="status-bar"><span class="dot ok" id="sd-ai"></span><span class="status-text" id="st-ai-text">IA</span><span class="status-value" id="sv-ai">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-agents"></span><span class="status-text">Agentes</span><span class="status-value" id="sv-agents">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-assets"></span><span class="status-text">Ativos</span><span class="status-value" id="sv-assets">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-ports"></span><span class="status-text">Port Change</span><span class="status-value" id="sv-ports">—</span></div>
        <div class="status-bar" style="margin-top:.5rem"><span class="dot ok" id="sd-certs"></span><span class="status-text">Cert Check</span><span class="status-value" id="sv-certs">—</span></div>
      </div>

      <div class="aside-panel">
        <div class="panel-title">Ações</div>
        <button class="btn btn-secondary" onclick="loadStatus()" style="width:100%;margin-bottom:.5rem">↺ Atualizar Status</button>
        <button class="btn btn-primary" onclick="saveAllSettings()" style="width:100%">💾 Salvar Tudo</button>
        <div id="feedback" style="margin-top:1rem"></div>
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
const AUTO_LABELS = { openai:'gpt-4o-mini', anthropic:'claude-haiku-4-5-20251001', deepseek:'deepseek-chat' };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => { if (k==='className') el.className=v; else el.setAttribute(k,v); });
  children.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c) el.appendChild(c); });
  return el;
}

function toggle(id) {
  return h('label', {className:'toggle-row'}, [
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
function markDirty(){ _dirty=true; }
function saveAllSettings(){
  const p = document.getElementById('settings-panel');
  const body = readCurrentSettings();
  fetch(API+'/system/settings',{method:'POST',headers:getHeaders(),body:JSON.stringify(body)})
    .then(r=>r.json()).then(d=>{
      _dirty=false;
      showFeedback(d.ok?'Configuração salva com sucesso':'Erro ao salvar',d.ok);
    }).catch(e=>showFeedback('Erro: '+e.message,false));
}
function readCurrentSettings(){
  return {
    discovery: {
      port_change_detection: document.getElementById('tog-port_change')?.checked,
      port_disappeared_grace_scans: parseInt(document.getElementById('sld-grace')?.value||2),
    },
    agents: {
      offline_check_enabled: document.getElementById('tog-agent_offline')?.checked,
      offline_threshold_minutes: parseInt(document.getElementById('sld-agent_timeout')?.value||5),
    },
    certs: {
      expiry_warning_days: parseInt(document.getElementById('sld-cert_warn')?.value||30),
      expiry_critical_days: parseInt(document.getElementById('sld-cert_crit')?.value||7),
    },
    os_defaults: {
      linux_node_exporter: document.getElementById('tog-os_linux')?.checked,
      windows_exporter: document.getElementById('tog-os_win')?.checked,
      network_snmp: document.getElementById('tog-os_snmp')?.checked,
    },
  };
}

function showFeedback(msg,ok){
  const el=document.getElementById('feedback');
  el.textContent=msg;el.className=ok?'ok':'err';
  setTimeout(()=>{el.textContent='';el.className='';},4000);
}

function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.textContent.includes(
    tab==='discovery'?'Descoberta':tab==='ai'?'IA':tab==='agents'?'Agentes':tab==='os'?'SO':'Certs')));
  const p=document.getElementById('settings-panel');
  if(tab==='discovery') renderDiscovery(p);
  else if(tab==='ai') renderAI(p);
  else if(tab==='agents') renderAgents(p);
  else if(tab==='os') renderOS(p);
  else if(tab==='certs') renderCerts(p);
}

// ── Discovery Tab ──
function renderDiscovery(el){
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Configuração de Descoberta'));
  el.appendChild(h('div',{className:'field'},[
    h('label',{},'Intervalo de Scan'),slider('scan_interval',1,1440,5,60,' min')
  ]));
  el.appendChild(h('div',{className:'field'},[
    h('div',{},toggle('port_change')),
    h('div',{className:'toggle-desc'},'Detectar portas que abriram ou fecharam entre scans'),
    h('div',{style:'margin-top:.8rem'},[
      h('label',{},'Scans antes de alertar porta fechada'),
      slider('grace',1,10,1,2,' scans')
    ])
  ]));
  document.getElementById('tog-port_change').checked=true;
  document.getElementById('sld-scan_interval').value=60;document.getElementById('sldv-scan_interval').textContent='60 min';
  document.getElementById('sld-grace').value=2;document.getElementById('sldv-grace').textContent='2 scans';
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
      h('label',{},'API Key'),
      h('div',{className:'key-row'},[
        h('input',{type:'password',id:'api-key',placeholder:'Cole a chave aqui',autocomplete:'new-password',oninput:'markDirty()'}),
        h('button',{className:'toggle-btn',onclick:'toggleKey()'},'👁')
      ]),
      h('div',{className:'hint'},'Deixe em branco para manter a chave atual.')
    ]));
  }
  el.appendChild(h('div',{className:'field'},[
    h('label',{},'Auto-Remediation Threshold'),slider('ai_threshold',0,100,5,85,'%'),
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
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Configuração de Agentes'));
  el.appendChild(h('div',{className:'field'},[toggle('agent_offline'),h('div',{className:'toggle-desc'},'Detectar agentes que pararam de responder')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Tempo para considerar offline'),slider('agent_timeout',1,60,1,5,' min')]));
  document.getElementById('tog-agent_offline').checked=true;
  document.getElementById('sld-agent_timeout').value=5;document.getElementById('sldv-agent_timeout').textContent='5 min';
}
// ── OS Tab ──
function renderOS(el){
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Monitoramento por Sistema Operacional'));
  el.appendChild(h('div',{className:'field'},[toggle('os_linux'),h('div',{className:'toggle-desc'},'Adicionar node_exporter automaticamente ao detectar Linux')]));
  el.appendChild(h('div',{className:'field'},[toggle('os_win'),h('div',{className:'toggle-desc'},'Adicionar windows_exporter ao detectar Windows')]));
  el.appendChild(h('div',{className:'field'},[toggle('os_snmp'),h('div',{className:'toggle-desc'},'Adicionar SNMP exporter ao detectar switches/roteadores')]));
  document.getElementById('tog-os_linux').checked=true;
  document.getElementById('tog-os_win').checked=true;
  document.getElementById('tog-os_snmp').checked=true;
}
// ── Certs Tab ──
function renderCerts(el){
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Verificação de Certificados TLS'));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Alertar quando expirar em (dias)'),slider('cert_warn',7,90,1,30,' dias')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Alerta crítico quando restarem (dias)'),slider('cert_crit',1,14,1,7,' dias')]));
  document.getElementById('sld-cert_warn').value=30;document.getElementById('sldv-cert_warn').textContent='30 dias';
  document.getElementById('sld-cert_crit').value=7;document.getElementById('sldv-cert_crit').textContent='7 dias';
}

// ── AI helpers ──
function getHeaders(){return{'Content-Type':'application/json'};}
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
    document.getElementById('save-ai-btn').disabled=false;
    renderAI(document.getElementById('settings-panel'));
  }).catch(()=>{});
}
async function saveAISettings(){
  const body={provider:_aiProvider,model:document.getElementById('model')?.value||'auto'};
  const key=document.getElementById('api-key')?.value;
  if(key)body.api_key=key;
  const r=await fetch(API+'/ai/settings',{method:'POST',headers:getHeaders(),body:JSON.stringify(body)});
  const d=await r.json();
  showFeedback(d.ok?'IA configurada com sucesso':'Erro: '+(d.error||'desconhecido'),d.ok);
  if(d.ok)loadAIStatus();
}

// ── Status ──
function loadStatus(){
  fetch(API+'/system/status',{headers:getHeaders()}).then(r=>r.json()).then(d=>{
    const ai=d.ai||{};const ag=d.agents||{};const disc=d.discovery||{};const s=d.settings||{};
    document.getElementById('st-ai').textContent=s.ai?.provider||'—';
    document.getElementById('st-agents').textContent=(ag.online||0)+'/'+(ag.total||0);
    document.getElementById('st-assets').textContent=disc.total_assets||0;
    document.getElementById('sv-ai').textContent=s.ai?.provider||'—';
    document.getElementById('sd-ai').className='dot '+(s.ai?.provider&&s.ai?.provider!=='mock'?'ok':'warn');
    document.getElementById('sv-agents').textContent=(ag.online||0)+' online, '+(ag.offline||0)+' offline';
    document.getElementById('sd-agents').className='dot '+(ag.offline>0?'err':(ag.online>0?'ok':'warn'));
    document.getElementById('sv-assets').textContent=(disc.total_assets||0)+' ativos';
    document.getElementById('sv-ports').textContent=s.discovery?.port_change_detection?'Ativo':'Inativo';
    document.getElementById('sd-ports').className='dot '+(s.discovery?.port_change_detection?'ok':'warn');
    document.getElementById('sv-certs').textContent='warning '+s.certs?.expiry_warning_days+'d, crit '+s.certs?.expiry_critical_days+'d';
    _allSettings=s;
  }).catch(e=>console.error('Status error:',e));
}

function logout(){fetch(API+'/auth/logout',{method:'POST',headers:getHeaders()}).finally(()=>location.href='/observe/login');}

// Init
switchTab('discovery');
loadStatus();
setInterval(loadStatus,30000);
</script>
</body>
</html>`;


// ─── Rota da página de configuração ────────────────────────────────────────
app.get('/observe/settings', requireAuth, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(SETTINGS_HTML);
});

app.get('/observe/config', requireAuth, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.end(SETTINGS_HTML);
});
