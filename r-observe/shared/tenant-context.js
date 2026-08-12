'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const DEFAULT_TENANT = 'default';
const TENANT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

function normalizeTenantId(value) {
  const tenantId = String(value || DEFAULT_TENANT);
  if (!TENANT_PATTERN.test(tenantId)) {
    const error = new Error('tenant_id inválido');
    error.code = 'INVALID_TENANT_ID';
    throw error;
  }
  return tenantId;
}

function runWithTenant(tenantId, callback) {
  return storage.run({ tenantId: normalizeTenantId(tenantId) }, callback);
}

function getTenantId() {
  return storage.getStore()?.tenantId || DEFAULT_TENANT;
}

async function setLocalTenant(sequelize, transaction, tenantId = getTenantId()) {
  const normalized = normalizeTenantId(tenantId);
  await sequelize.query(
    "SELECT set_config('app.tenant_id', $1, true)",
    { bind: [normalized], transaction }
  );
  return normalized;
}

module.exports = {
  DEFAULT_TENANT,
  normalizeTenantId,
  runWithTenant,
  getTenantId,
  setLocalTenant,
};
