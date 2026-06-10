'use strict';

/**
 * Quota Middleware para R-Observe Discovery (Enterprise).
 *
 * Verifica limites de recursos por tenant antes de permitir operações.
 * Lê quotas da tabela observe_tenant_quotas.
 *
 * Uso:
 *   const { requireQuota } = require('./quotas');
 *   app.post('/api/discovery/targets', requireQuota('targets'), handler);
 */

const { log } = require('./utils/logger');

const QUOTA_CACHE_TTL_MS = 30000; // 30 segundos de cache
const _quotaCache = new Map();

async function getQuota(db, tenantId) {
  const now = Date.now();
  const cached = _quotaCache.get(tenantId);
  if (cached && now - cached.ts < QUOTA_CACHE_TTL_MS) return cached.data;

  try {
    const r = await db.query(
      `SELECT * FROM observe_tenant_quotas WHERE tenant_id = $1`,
      [String(tenantId)]
    );
    const quota = r.rowCount ? r.rows[0] : {
      tenant_id: tenantId,
      max_assets: 5000,
      max_targets: 500,
      max_scans_per_hour: 10,
      max_concurrent_scans: 1,
    };
    _quotaCache.set(tenantId, { data: quota, ts: now });
    return quota;
  } catch (e) {
    log('warn', 'Quota lookup failed', { err: e.message, tenant_id: tenantId });
    return null; // fail open — não bloqueia por falha de infra
  }
}

function invalidateQuotaCache(tenantId) {
  _quotaCache.delete(String(tenantId));
}

/**
 * Conta assets atuais do tenant.
 */
async function countAssets(db, tenantId, siteId, edgeId) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM observe_assets
       WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3
         AND lifecycle_state NOT IN ('ignored', 'disappeared')`,
      [String(tenantId), String(siteId || 'default-site'), String(edgeId || 'central')]
    );
    return r.rows[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

/**
 * Conta targets ativos do tenant.
 */
async function countTargets(db, tenantId, siteId, edgeId) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM observe_discovery_targets
       WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND enabled = true`,
      [String(tenantId), String(siteId || 'default-site'), String(edgeId || 'central')]
    );
    return r.rows[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

/**
 * Conta scans na última hora do tenant.
 */
async function countRecentScans(db, tenantId, siteId, edgeId) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM observe_discovery_runs
       WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3
         AND started_at > NOW() - INTERVAL '1 hour'`,
      [String(tenantId), String(siteId || 'default-site'), String(edgeId || 'central')]
    );
    return r.rows[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

/**
 * Middleware factory: verifica quota antes da operação.
 *
 * @param {'targets'|'assets'|'scans'} resource - Tipo de recurso a verificar
 * @returns {Function} middleware Express
 */
function requireQuota(resource) {
  return async (req, _res, next) => {
    const tenantId = String(req.body?.tenant_id || req.query?.tenant_id || 'default');
    const siteId = String(req.body?.site_id || req.query?.site_id || 'default-site');
    const edgeId = String(req.body?.edge_id || req.query?.edge_id || 'central');

    const quota = await getQuota(req._db || req.app?.locals?.db, tenantId);
    if (!quota) return next(); // fail open

    req._quota = quota;

    try {
      switch (resource) {
        case 'targets': {
          const current = await countTargets(req._db || req.app?.locals?.db, tenantId, siteId, edgeId);
          if (current >= quota.max_targets) {
            return _res.status(429).json({
              error: 'Quota exceeded',
              resource: 'targets',
              current,
              max: quota.max_targets,
              retry_after: 'Reduce targets or contact administrator',
            });
          }
          break;
        }
        case 'assets': {
          const current = await countAssets(req._db || req.app?.locals?.db, tenantId, siteId, edgeId);
          if (current >= quota.max_assets) {
            return _res.status(429).json({
              error: 'Quota exceeded',
              resource: 'assets',
              current,
              max: quota.max_assets,
            });
          }
          break;
        }
        case 'scans': {
          const recent = await countRecentScans(req._db || req.app?.locals?.db, tenantId, siteId, edgeId);
          if (recent >= quota.max_scans_per_hour) {
            return _res.status(429).json({
              error: 'Quota exceeded',
              resource: 'scans',
              current: recent,
              max_per_hour: quota.max_scans_per_hour,
              retry_after_seconds: 3600,
            });
          }
          break;
        }
      }
    } catch (e) {
      log('warn', 'Quota check failed', { err: e.message, resource, tenant_id: tenantId });
      // fail open
    }

    next();
  };
}

module.exports = { requireQuota, getQuota, invalidateQuotaCache };
