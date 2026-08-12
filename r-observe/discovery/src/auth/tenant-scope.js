'use strict';

function normalizeScopes(scope) {
  return Array.isArray(scope)
    ? scope.map(String)
    : String(scope || '').split(/[ ,]+/).filter(Boolean);
}

function hasCrossTenantScope(auth = {}) {
  const scopes = normalizeScopes(auth.scope);
  return scopes.includes('tenant:all') || scopes.includes('*');
}

function resolveTenantId(auth = {}, requestedTenant) {
  const authenticatedTenant = String(auth.tenantId || 'default');
  if (!hasCrossTenantScope(auth) || requestedTenant == null) return authenticatedTenant;
  return String(requestedTenant);
}

function parseScope(input = {}, auth = {}) {
  const hasAuthContext = auth && (auth.tenantId != null || auth.tenant_id != null || auth.scope != null);
  const effectiveAuth = hasAuthContext ? auth : { tenantId: input.tenant_id || 'default' };
  return {
    tenant_id: resolveTenantId(effectiveAuth, input.tenant_id),
    site_id: String(input.site_id || 'default-site'),
    edge_id: String(input.edge_id || 'central'),
  };
}

module.exports = { normalizeScopes, hasCrossTenantScope, resolveTenantId, parseScope };
