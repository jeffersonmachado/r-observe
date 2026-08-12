'use strict';

/**
 * AI Service Classifier — valida mapeamentos porta→serviço via LLM.
 *
 * Cache em memória: evita chamadas repetidas para o mesmo IP:porta.
 * Fallback: se AI offline, retorna null (usa knowledge base).
 */

const { debug, log } = require('../utils/logger');
const { signInternalToken } = require('@results/auth');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://r-observe-ai:3000';
const AI_TIMEOUT_MS = parseInt(process.env.AI_CLASSIFY_TIMEOUT_MS || '4000', 10);
const AI_ENABLED = process.env.DISCOVERY_AI_CLASSIFY_ENABLED !== 'false';

// Cache: "ip:port" → { service, confidence, timestamp }
const _cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

/**
 * Valida mapeamento de porta via IA.
 * @param {string} ip
 * @param {number} port
 * @param {string} currentLabel - classificação atual (da knowledge base)
 * @param {object} evidence - http_banner, tcp_banner, hostname
 * @returns {object|null} { service, is_exporter, exporter_job, confidence, reason } ou null
 */
async function classifyService(ip, port, currentLabel, evidence = {}) {
  if (!AI_ENABLED) return null;

  const cacheKey = `${ip}:${port}`;
  const cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    debug(`ai-classify:cache-hit ${cacheKey} → ${cached.service}`);
    return cached;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    const resp = await fetch(`${AI_SERVICE_URL}/ai/classify-service`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': signInternalToken({ sub: 'r-observe-discovery', service: 'discovery', role: 'operator', aud: 'ai', scope: ['ai:access'] }),
      },
      body: JSON.stringify({
        ip,
        port,
        current_label: currentLabel,
        http_banner: evidence.http_banner || null,
        tcp_banner: evidence.tcp_banner || null,
        hostname: evidence.hostname || null,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      log('warn', 'ai-classify: API error', { status: resp.status, ip, port });
      return null;
    }

    const result = await resp.json();
    if (result.ai_fallback) {
      debug(`ai-classify:fallback ${cacheKey} → ${result.service}`);
      return null; // AI indisponível, usa knowledge base
    }

    _cache.set(cacheKey, { ...result, timestamp: Date.now() });
    debug(`ai-classify:validated ${cacheKey} → ${result.service} (confidence: ${result.confidence})`);
    return result;
  } catch (e) {
    debug(`ai-classify:error ${cacheKey} → ${e.message}`);
    return null;
  }
}

/**
 * Limpa cache (útil para testes ou hot-reload).
 */
function clearCache() {
  _cache.clear();
}

module.exports = { classifyService, clearCache };
