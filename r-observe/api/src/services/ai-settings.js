'use strict';

const { signInternalToken } = require('@results/auth');
const { getTenantId } = require('../shared/tenant-context');

/**
 * Serviço de persistência e reconciliação de settings de IA.
 * Extraído de index.js para reduzir o tamanho do arquivo principal.
 */

function createAISettingsService({
  db,
  log,
  logAIReconcileIssue,
  processEnv,
  signToken = signInternalToken,
  resolveTenantId = getTenantId,
  fetchImpl = global.fetch,
}) {
  const AI_SERVICE_URL = processEnv.AI_SERVICE_URL || 'http://observe-ai:3000';
  const AI_TIMEOUT_MS = parseInt(processEnv.AI_TIMEOUT_MS || '30000', 10);
  const DISCOVERY_SERVICE_URL = processEnv.DISCOVERY_SERVICE_URL || 'http://observe-discovery:3010';
  const DISCOVERY_TIMEOUT_MS = parseInt(processEnv.DISCOVERY_TIMEOUT_MS || '30000', 10);

  async function proxyToAI(path, options = {}) {
    const timeout = AI_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const jwt = signToken({ sub: 'r-observe-api', service: 'api', role: 'operator', aud: 'ai', scope: ['ai:access', 'ai:settings:write'], tenant_id: resolveTenantId() });
    try {
      const resp = await fetchImpl(`${AI_SERVICE_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'x-internal-token': jwt, ...(options.headers || {}) },
        signal: ctrl.signal,
      });
      return { ok: true, status: resp.status, data: await resp.json() };
    } catch (e) {
      if (e.name === 'AbortError') {
        return { ok: false, status: 504, data: { error: 'AI service timeout', detail: `Timeout after ${timeout}ms`, upstream: AI_SERVICE_URL, path } };
      }
      return { ok: false, status: 502, data: { error: 'AI service unavailable', detail: e.message, upstream: AI_SERVICE_URL, path } };
    } finally {
      clearTimeout(timer);
    }
  }

  function aiProxyFailureExtra(result, extra = {}) {
    const data = result?.data || {};
    return {
      ...extra,
      status: result?.status,
      ai_error: data.error,
      detail: data.detail,
      upstream: data.upstream,
      path: data.path,
    };
  }

  async function proxyToDiscovery(path, options = {}) {
    const timeout = DISCOVERY_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const jwt = signToken({
      sub: 'r-observe-api',
      service: 'api',
      role: 'operator',
      aud: 'discovery',
      scope: ['discovery:access', 'discovery:write'],
      tenant_id: resolveTenantId(),
    });
    try {
      const resp = await fetchImpl(`${DISCOVERY_SERVICE_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'x-internal-token': jwt, ...(options.headers || {}) },
        signal: ctrl.signal,
      });
      const raw = await resp.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw }; }
      const headers = {};
      resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return { ok: true, status: resp.status, data, raw, headers };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, status: 504, data: { error: 'Discovery timeout' } };
      return { ok: false, status: 502, data: { error: 'Discovery service unavailable', detail: e.message } };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getPersistedAISettings() {
    try {
      const r = await db.query(
        `SELECT provider, model, api_key, updated_at
           FROM observe_ai_settings
          WHERE id = 1`
      );
      return r.rowCount ? r.rows[0] : null;
    } catch (e) {
      log('warn', 'AI settings table unavailable', { err: e.message });
      return null;
    }
  }

  async function upsertPersistedAISettings(partial = {}) {
    const current = (await getPersistedAISettings()) || { provider: 'mock', model: 'auto', api_key: null };

    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const next = {
      provider: has(partial, 'provider') ? partial.provider : current.provider,
      model: has(partial, 'model') ? partial.model : current.model,
      api_key: has(partial, 'api_key') ? partial.api_key : current.api_key,
    };

    await db.query(
      `INSERT INTO observe_ai_settings (id, provider, model, api_key, updated_at)
       VALUES (1, $1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE
       SET provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           api_key = EXCLUDED.api_key,
           updated_at = NOW()`,
      [next.provider, next.model, next.api_key || null]
    );

    return next;
  }

  async function applyPersistedAISettingsOnStartup() {
    const persisted = await getPersistedAISettings();
    if (!persisted) return;

    const payload = {
      provider: persisted.provider,
      model: persisted.model,
    };
    if (persisted.api_key) payload.api_key = persisted.api_key;

    const result = await proxyToAI('/ai/settings', { method: 'POST', body: JSON.stringify(payload) });
    if (!result.ok || result.status >= 400) {
      logAIReconcileIssue('Failed to apply persisted AI settings on startup', aiProxyFailureExtra(result));
      return;
    }
    log('info', 'Persisted AI settings applied on startup', { provider: persisted.provider, model: persisted.model });
  }

  async function reconcilePersistedAISettings(reason = 'manual') {
    const persisted = await getPersistedAISettings();
    if (!persisted) return { synced: false, reason: 'no_persisted_settings' };

    const payload = {
      provider: persisted.provider,
      model: persisted.model,
    };
    if (persisted.api_key) payload.api_key = persisted.api_key;

    const current = await proxyToAI('/ai/settings');
    if (!current.ok || current.status >= 400) {
      const applied = await proxyToAI('/ai/settings', { method: 'POST', body: JSON.stringify(payload) });
      if (!applied.ok || applied.status >= 400) {
        logAIReconcileIssue('Failed to reconcile persisted AI settings', aiProxyFailureExtra(applied, { reason }));
        return { synced: false, reason: 'apply_failed' };
      }
      log('info', 'Persisted AI settings reconciled', { reason, provider: persisted.provider, model: persisted.model, mode: 'recover' });
      return { synced: true, changed: true };
    }

    const currentData = current.data || {};
    const driftDetected =
      currentData.provider !== persisted.provider ||
      currentData.model !== persisted.model ||
      (!!currentData.has_api_key) !== (!!persisted.api_key);

    if (!driftDetected) {
      return { synced: true, changed: false };
    }

    const applied = await proxyToAI('/ai/settings', { method: 'POST', body: JSON.stringify(payload) });
    if (!applied.ok || applied.status >= 400) {
      logAIReconcileIssue('Failed to apply drift correction for AI settings', aiProxyFailureExtra(applied, { reason }));
      return { synced: false, reason: 'drift_apply_failed' };
    }

    log('info', 'AI settings drift corrected from persisted DB state', { reason, provider: persisted.provider, model: persisted.model });
    return { synced: true, changed: true };
  }

  // Valida a chave diretamente no provider antes de persistir.
  // Retorna { valid:false } apenas quando o provider rejeita a autenticação (401/403);
  // falha de rede/timeout não bloqueia (retorna valid:true + reason:'unreachable').
  const PROVIDER_KEY_ENDPOINTS = {
    openai:    { url: 'https://api.openai.com/v1/models',    header: 'Authorization', auth: (k) => `Bearer ${k}` },
    deepseek:  { url: 'https://api.deepseek.com/v1/models',  header: 'Authorization', auth: (k) => `Bearer ${k}` },
    anthropic: { url: 'https://api.anthropic.com/v1/models', header: 'x-api-key',     auth: (k) => k, extra: { 'anthropic-version': '2023-06-01' } },
  };

  async function validateProviderKey(provider, apiKey) {
    const cfg = PROVIDER_KEY_ENDPOINTS[provider];
    if (!cfg || !apiKey) return { valid: true };
    try {
      const resp = await fetchImpl(cfg.url, {
        headers: { [cfg.header]: cfg.auth(apiKey), ...(cfg.extra || {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.status === 401 || resp.status === 403) {
        return { valid: false, reason: 'authentication_failed', status: resp.status };
      }
      return { valid: true };
    } catch (e) {
      return { valid: true, reason: 'unreachable', detail: e.message };
    }
  }

  // Validação cacheada (TTL 5 min) para o status da UI sem chamar o provider a cada poll.
  const keyStatusCache = new Map(); // `${provider}:${apiKey}` -> { result, at }

  async function getProviderKeyStatus(provider, apiKey) {
    if (!provider || provider === 'mock') return { status: 'mock' };
    if (!apiKey) return { status: 'no_key' };
    const cacheKey = `${provider}:${apiKey}`;
    const cached = keyStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 300000) return cached.result;
    const v = await validateProviderKey(provider, apiKey);
    const result = { status: v.valid ? 'ok' : 'invalid', detail: v.reason || null };
    keyStatusCache.set(cacheKey, { result, at: Date.now() });
    if (keyStatusCache.size > 20) {
      const oldest = keyStatusCache.keys().next().value;
      keyStatusCache.delete(oldest);
    }
    return result;
  }

  return {
    proxyToAI,
    aiProxyFailureExtra,
    proxyToDiscovery,
    getPersistedAISettings,
    upsertPersistedAISettings,
    applyPersistedAISettingsOnStartup,
    reconcilePersistedAISettings,
    validateProviderKey,
    getProviderKeyStatus,
  };
}

module.exports = { createAISettingsService };
