'use strict';

/**
 * Audit Log Middleware para R-Observe API (Enterprise).
 *
 * Registra acoes administrativas e de IA na tabela observe_audit_log.
 * Deve ser usado apos o middleware de autenticacao (req.auth preenchido).
 *
 * Uso:
 *   const { audit, logAudit } = require('./audit');
 *   app.use(audit);
 *   // No handler: await logAudit(db, req, { resource_id: ..., summary_suffix: '...' });
 */

// ─── Mapeamento de rotas → acoes ─────────────────────────────────────────
const ROUTE_ACTIONS = {
  // AI Settings
  'POST /observe/api/ai/settings':           { action: 'ai.settings.update',  resource: 'ai_settings' },

  // AI Explain
  'POST /observe/api/ai/explain':            { action: 'ai.explain',          resource: 'ai_explain' },

  // AI Catalog CRUD
  'POST /observe/api/ai/catalog':            { action: 'ai.catalog.create',   resource: 'ai_catalog' },
  'PATCH /observe/api/ai/catalog/:action':   { action: 'ai.catalog.update',   resource: 'ai_catalog' },
  'DELETE /observe/api/ai/catalog/:action':  { action: 'ai.catalog.delete',   resource: 'ai_catalog' },

  // AI Feedback
  'POST /observe/api/ai/feedback':           { action: 'ai.feedback',         resource: 'ai_feedback' },

  // Remediations
  'POST /observe/api/remediation/request':   { action: 'remediation.request', resource: 'remediation' },
  'POST /observe/api/remediation/:id/approve': { action: 'remediation.approve', resource: 'remediation' },
  'POST /observe/api/remediation/:id/reject':  { action: 'remediation.reject',  resource: 'remediation' },
};

function matchRoute(method, path) {
  const normalized = `${method.toUpperCase()} ${path}`;
  if (ROUTE_ACTIONS[normalized]) return ROUTE_ACTIONS[normalized];

  // Pattern matching para rotas com parametros (:action, :id)
  for (const [pattern, def] of Object.entries(ROUTE_ACTIONS)) {
    const [pmethod, ppath] = pattern.split(' ');
    if (pmethod !== method.toUpperCase()) continue;
    const regex = new RegExp('^' + ppath.replace(/:action/g, '[^/]+').replace(/:id/g, '[^/]+') + '$');
    if (regex.test(path)) return def;
  }
  return null;
}

function extractActorIp(req) {
  return String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    ''
  ) || null;
}

function buildSummary(def, req) {
  const parts = [];
  if (req.body?.action) parts.push(`action=${req.body.action}`);
  if (req.body?.provider) parts.push(`provider=${req.body.provider}`);
  if (req.body?.model) parts.push(`model=${req.body.model}`);
  if (req.body?.incident_id) parts.push(`incident=${String(req.body.incident_id).substring(0, 8)}`);
  if (req.body?.rating) parts.push(`rating=${req.body.rating}`);
  if (req.params?.action) parts.push(`catalog=${req.params.action}`);
  if (req.params?.id) parts.push(`id=${req.params.id}`);
  return `${def.action}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

/**
 * Middleware global: injeta req._auditMeta com actor/ip para uso posterior.
 */
function audit(req, _res, next) {
  req._auditMeta = {
    actor: req.auth?.user || 'anonymous',
    actor_role: req.auth?.role || 'unknown',
    actor_ip: extractActorIp(req),
  };
  next();
}

/**
 * Hook de pos-processamento: registra no banco apos a resposta.
 * Chamado no final do handler da rota.
 * @param {object} db - cliente de banco de dados
 * @param {object} req - request do Express
 * @param {object} extra - { resource_id, resource_key, summary_suffix }
 */
async function logAudit(db, req, extra = {}) {
  const def = req._auditAction || matchRoute(req.method, req.originalUrl || req.path);
  if (!def) return;

  const meta = req._auditMeta || {};
  const scope = {
    tenant_id: 'default',
    site_id: 'default-site',
    edge_id: 'central',
  };

  const resourceId = req.params?.id || req.params?.action || extra.resource_id || null;
  const resourceKey = req.body?.action || req.body?.incident_id || extra.resource_key || null;

  try {
    await db.query(
      `INSERT INTO observe_audit_log
        (tenant_id, site_id, edge_id, actor, actor_role, actor_ip, action, resource_type, resource_id, resource_key, summary, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        String(scope.tenant_id),
        String(scope.site_id),
        String(scope.edge_id),
        meta.actor,
        meta.actor_role,
        meta.actor_ip,
        def.action,
        def.resource,
        resourceId,
        resourceKey,
        buildSummary(def, req) + (extra.summary_suffix || ''),
        JSON.stringify({
          method: req.method,
          path: req.originalUrl || req.path,
          query: req.query,
          body: stripSensitive(req.body || {}),
          params: req.params || {},
          extra: extra || {},
        }),
      ]
    );
  } catch (e) {
    // Audit falha nunca deve quebrar o fluxo principal
    // log function is passed via closure or we just silently ignore
  }
}

function stripSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = { ...obj };
  const sensitive = ['password', 'api_key', 'token', 'secret', 'pass', 'key', 'auth', 'credential'];
  for (const key of Object.keys(cleaned)) {
    const lower = key.toLowerCase();
    if (sensitive.some(s => lower.includes(s))) {
      cleaned[key] = '***REDACTED***';
    }
    if (typeof cleaned[key] === 'object' && cleaned[key] !== null) {
      cleaned[key] = stripSensitive(cleaned[key]);
    }
  }
  return cleaned;
}

module.exports = { audit, logAudit, matchRoute, ROUTE_ACTIONS };
