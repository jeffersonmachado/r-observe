'use strict';

/**
 * Audit Log Middleware para R-Observe Discovery (Enterprise).
 *
 * Registra ações administrativas na tabela observe_audit_log.
 * Deve ser usado após o middleware de autenticação (req.auth preenchido).
 *
 * Uso:
 *   const { audit, auditRoute } = require('./audit');
 *   app.use(audit);                          // middleware global (extrai actor/ip)
 *   app.post('/api/...', auditRoute('target.create', 'target'), handler);
 */

const { log } = require('./utils/logger');

// ─── Mapeamento de rotas → ações ─────────────────────────────────────────
const ROUTE_ACTIONS = {
  // Policies
  'POST /api/discovery/policies':         { action: 'policy.create',  resource: 'policy' },
  'PATCH /api/discovery/policies/:id':    { action: 'policy.update',  resource: 'policy' },
  'DELETE /api/discovery/policies/:id':   { action: 'policy.delete',  resource: 'policy' },

  // Targets
  'POST /api/discovery/targets':          { action: 'target.create',  resource: 'target' },
  'PATCH /api/discovery/targets/:id':     { action: 'target.update',  resource: 'target' },
  'DELETE /api/discovery/targets/:id':    { action: 'target.delete',  resource: 'target' },

  // Assets
  'PATCH /api/discovery/assets/:id':      { action: 'asset.update',   resource: 'asset' },

  // Scan
  'POST /api/discovery/scan':             { action: 'scan.trigger',   resource: 'scan' },

  // Passive
  'POST /api/discovery/passive/events':   { action: 'passive.ingest', resource: 'finding' },

  // Administrative operations
  'POST /api/discovery/snmp/deep/:host':  { action: 'snmp.deep.scan', resource: 'host' },
  'POST /api/discovery/ipam/subnets':     { action: 'ipam.subnet.create', resource: 'subnet' },
  'POST /api/discovery/alerts/:id/acknowledge': { action: 'alert.acknowledge', resource: 'alert' },
  'POST /api/discovery/config-backup/:host': { action: 'config.backup', resource: 'host' },
};

function matchRoute(method, path) {
  const normalized = `${method.toUpperCase()} ${path}`;
  if (ROUTE_ACTIONS[normalized]) return ROUTE_ACTIONS[normalized];

  // Pattern matching para segmentos parametrizados.
  for (const [pattern, def] of Object.entries(ROUTE_ACTIONS)) {
    const [pmethod, ppath] = pattern.split(' ');
    if (pmethod !== method.toUpperCase()) continue;
    const regex = new RegExp('^' + ppath.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, '[^/]+') + '$');
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
  if (req.body?.name) parts.push(`name="${req.body.name}"`);
  if (req.body?.address) parts.push(`address=${req.body.address}`);
  if (req.body?.lifecycle_state) parts.push(`→${req.body.lifecycle_state}`);
  if (req.body?.profile) parts.push(`profile=${req.body.profile}`);
  if (req.params?.id) parts.push(`id=${req.params.id}`);
  if (req.params?.host) parts.push(`host=${req.params.host}`);
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

/**
 * Wrapper que audita automaticamente com base no mapeamento de rotas.
 * Deve ser usado como: auditRoute('target.create', 'target')(req, res, next)
 */
function auditRoute(action, resourceType) {
  return (req, _res, next) => {
    req._auditAction = { action, resource_type: resourceType };
    next();
  };
}

/**
 * Hook de pós-processamento: registra no banco após a resposta.
 * Chamado no final do handler da rota.
 */
async function logAudit(db, req, extra = {}) {
  const def = req._auditAction || matchRoute(req.method, req.path);
  if (!def) return;

  const meta = req._auditMeta || {};
  const scope = {
    tenant_id: req.auth?.tenantId || req.query?.tenant_id || req.body?.tenant_id || 'default',
    site_id: req.query?.site_id || req.body?.site_id || 'default-site',
    edge_id: req.query?.edge_id || req.body?.edge_id || 'central',
  };

  const resourceId = req.params?.id || req.params?.host || extra.resource_id || null;
  const resourceKey = req.body?.address || req.body?.asset_key || extra.resource_key || null;

  try {
    await db.query(
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
          path: req.path,
          query: req.query,
          body: stripSensitive(req.body || {}),
          params: req.params || {},
          extra: extra || {},
        }),
      ]
    );
  } catch (e) {
    // Audit falha nunca deve quebrar o fluxo principal
    log('warn', 'Audit log write failed', { err: e.message, action: def.action });
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

module.exports = { audit, auditRoute, logAudit, matchRoute, ROUTE_ACTIONS };
