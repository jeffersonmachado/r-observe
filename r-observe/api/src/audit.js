'use strict';

const { runWithTenant } = require('./shared/tenant-context');

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
  // Contacts and inventory
  'POST /observe/api/contacts':               { action: 'contact.create', resource: 'contact' },
  'PATCH /observe/api/contacts/:name':        { action: 'contact.update', resource: 'contact' },
  'POST /observe/api/hosts':                  { action: 'host.upsert', resource: 'host' },
  'DELETE /observe/api/hosts/:name':          { action: 'host.delete', resource: 'host' },
  'POST /observe/api/hosts/scan':             { action: 'host.scan', resource: 'host' },
  'POST /observe/api/inventory/docker':       { action: 'inventory.docker', resource: 'inventory' },

  // Settings and discovery proxy
  'POST /observe/api/system/settings':             { action: 'system.settings.update', resource: 'system_settings' },
  'POST /observe/api/discovery/policies':          { action: 'discovery.policy.create', resource: 'policy' },
  'PATCH /observe/api/discovery/policies/:id':     { action: 'discovery.policy.update', resource: 'policy' },
  'DELETE /observe/api/discovery/policies/:id':    { action: 'discovery.policy.delete', resource: 'policy' },
  'POST /observe/api/discovery/scan':              { action: 'discovery.scan', resource: 'scan' },
  'POST /observe/api/discovery/targets':           { action: 'discovery.target.create', resource: 'target' },
  'PATCH /observe/api/discovery/targets/:id':      { action: 'discovery.target.update', resource: 'target' },
  'DELETE /observe/api/discovery/targets/:id':     { action: 'discovery.target.delete', resource: 'target' },
  'PATCH /observe/api/discovery/assets/:id':       { action: 'discovery.asset.update', resource: 'asset' },
  'POST /observe/api/discovery/schedules':         { action: 'discovery.schedule.create', resource: 'schedule' },
  'PATCH /observe/api/discovery/schedules/:id':    { action: 'discovery.schedule.update', resource: 'schedule' },
  'DELETE /observe/api/discovery/schedules/:id':   { action: 'discovery.schedule.delete', resource: 'schedule' },

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
    const regex = new RegExp('^' + ppath.replace(/:(?:action|id|name)/g, '[^/]+') + '$');
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
    actor_ip: extractActorIp(req),
  };
  next();
}

function canonicalAuditPath(path, basePath = '/observe/api') {
  if (basePath !== '/observe/api' && path.startsWith(basePath)) {
    return `/observe/api${path.slice(basePath.length)}`;
  }
  return path;
}

function createAuditMiddleware(db, log = () => {}, { basePath = '/observe/api' } = {}) {
  return (req, res, next) => {
    audit(req, res, () => {});
    req._auditLogger = log;
    const def = matchRoute(req.method, canonicalAuditPath(req.path, basePath));
    if (def) {
      req._auditAction = def;
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          void logAudit(db, req, { response_status: res.statusCode });
        }
      });
    }
    next();
  };
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
    tenant_id: req.auth?.tenantId || req.auth?.tenant_id || 'default',
    site_id: req.auth?.site_id || 'default-site',
    edge_id: req.auth?.edge_id || 'central',
  };

  const resourceId = req.params?.id || req.params?.action || extra.resource_id || null;
  const resourceKey = req.body?.action || req.body?.incident_id || extra.resource_key || null;

  try {
    await runWithTenant(scope.tenant_id, () => db.query(
      `INSERT INTO observe_audit_log
        (tenant_id, site_id, edge_id, actor, actor_role, actor_ip, action, resource_type, resource_id, resource_key, summary, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        String(scope.tenant_id),
        String(scope.site_id),
        String(scope.edge_id),
        req.auth?.user || req.auth?.service || 'unknown',
        req.auth?.role || 'unknown',
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
    ));
  } catch (e) {
    req._auditLogger?.('warn', 'Audit log write failed', { action: def.action, exception: e.name });
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

module.exports = { audit, canonicalAuditPath, createAuditMiddleware, logAudit, matchRoute, ROUTE_ACTIONS, stripSensitive };
