'use strict';

const { log } = require('../utils/logger');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || process.env.DISCOVERY_AI_URL || 'http://127.0.0.1:3011';
const JWT_SECRET = process.env.JWT_SECRET || '';
const AI_TIMEOUT_MS  = parseInt(process.env.AI_FINGERPRINT_TIMEOUT_MS || '8000', 10);
const CACHE_TTL_MS   = parseInt(process.env.AI_FINGERPRINT_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10); // 24h

// Cache em memória: asset_key → { result, ts }
const _cache = new Map();

function cacheKey(signals) {
  // Chave determinística pelos sinais mais estáveis
  return [signals.mac, signals.ssdp_server, signals.hostname, (signals.mdns_services || []).sort().join(',')].filter(Boolean).join('|');
}

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return entry.result;
}

function putCache(key, result) {
  _cache.set(key, { result, ts: Date.now() });
  if (_cache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of _cache) {
      if (now - v.ts > CACHE_TTL_MS) _cache.delete(k);
    }
  }
}

/**
 * Chama o serviço AI para identificar um dispositivo desconhecido.
 * Retorna null se o serviço estiver indisponível ou der timeout.
 *
 * @param {object} signals - Sinais passivos do dispositivo
 * @returns {Promise<{vendor, product, category, technology, asset_type, confidence, reasoning}|null>}
 */
async function aiFingerprint(signals) {
  const key = cacheKey(signals);
  const cached = getCached(key);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    const resp = await fetch(`${AI_SERVICE_URL}/ai/fingerprint`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-internal-token': JWT_SECRET,
      },
      body: JSON.stringify({ signals }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      log('warn', 'AI fingerprint: resposta não-ok', { status: resp.status });
      return null;
    }

    const result = await resp.json();
    if (result && typeof result.confidence === 'number') {
      putCache(key, result);
      log('info', 'AI fingerprint: dispositivo identificado', {
        vendor: result.vendor, product: result.product,
        confidence: result.confidence, provider: result.provider,
      });
      return result;
    }
    return null;
  } catch (e) {
    if (e.name !== 'AbortError') {
      log('warn', 'AI fingerprint: falha na chamada', { err: e.message });
    }
    return null;
  }
}

/**
 * Decide se vale chamar a IA (evita chamadas desnecessárias para dispositivos já conhecidos).
 * @param {object} fp - Resultado do fingerprintAsset local
 */
function shouldEnrichWithAI(fp) {
  const weakVendor  = !fp.vendor  || fp.vendor  === 'Não identificado' || fp.vendor  === 'Nao identificado';
  const weakProduct = !fp.product || fp.product === 'Sem sinal de serviço' || fp.product === 'Sem sinal de servico';
  // Chama IA se o fabricante for desconhecido (qualquer confiança), ou se confiança for baixa
  return weakVendor || weakProduct || fp.confidence < 0.65;
}

module.exports = { aiFingerprint, shouldEnrichWithAI };
