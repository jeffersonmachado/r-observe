'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { requireJwt, requireScope } = require('@results/auth');

const { createLifecycle } = require('../shared/lifecycle');

// ─── AIOps Engine ──────────────────────────────────────────────────────────
const { analyzeRootCause } = require('./root-cause-engine');
const { deduplicateAlerts, clusterEvents, detectPatterns, correlationScore } = require('./correlation-engine');
const { IncidentStore, findSimilarIncidents } = require('./incident-memory');
const { findPlaybooks, FeedbackLoop } = require('./knowledge-base');

// ─── AIOps State ───────────────────────────────────────────────────────────
const incidentStore = new IncidentStore({ maxSize: 5000 });
const feedbackLoop = new FeedbackLoop();
let aiAnalysesCount = 0;

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '3000', 10);
const LOG_LEVEL      = process.env.LOG_LEVEL || 'info';
const AI_TIMEOUT_MS  = parseInt(process.env.AI_TIMEOUT_MS || '30000', 10);

const {
  VALID_AI_PROVIDERS: VALID_PROVIDERS,
  AI_AUTO_MODELS: AUTO_MODELS,
  AI_STATIC_MODELS: STATIC_MODELS,
  OPENAI_CHAT_PREFIXES,
  OPENAI_EXCLUDE_PARTS,
  REMEDIATION_CATALOG,
  SYSTEM_PROMPT,
  sortModelsByRecency,
  resolveModel,
} = require('../shared/ai-models');

// Busca a lista real de modelos na API do provider; fallback para lista estática.
// Retorna { models, source, reason? } onde source é 'api' ou 'static'.
async function fetchProviderModels(provider) {
  if (!runtimeConfig.apiKey) {
    log('warn', 'AI models fallback: no API key configured in runtime', { provider });
    return { models: sortModelsByRecency(STATIC_MODELS[provider] || []), source: 'static', reason: 'no_key' };
  }

  try {
    if (provider === 'openai') {
      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${runtimeConfig.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        log('warn', 'OpenAI models API error', { status: resp.status });
        return { models: sortModelsByRecency(STATIC_MODELS.openai), source: 'static', reason: 'api_error', status: resp.status };
      }
      const { data } = await resp.json();
      return {
        models: sortModelsByRecency(
          data
            .map(m => m.id)
            .filter(id =>
              OPENAI_CHAT_PREFIXES.some(p => id.startsWith(p)) &&
              !OPENAI_EXCLUDE_PARTS.some(x => id.includes(x))
            )
        ),
        source: 'api',
      };
    }

    if (provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': runtimeConfig.apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        log('warn', 'Anthropic models API error', { status: resp.status });
        return { models: STATIC_MODELS.anthropic, source: 'static', reason: 'api_error', status: resp.status };
      }
      const { data } = await resp.json();
      return { models: data.map(m => m.id), source: 'api' }; // Anthropic API já retorna do mais recente
    }

    if (provider === 'deepseek') {
      const resp = await fetch('https://api.deepseek.com/v1/models', {
        headers: { Authorization: `Bearer ${runtimeConfig.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        log('warn', 'DeepSeek models API error', { status: resp.status });
        return { models: sortModelsByRecency(STATIC_MODELS.deepseek || []), source: 'static', reason: 'api_error', status: resp.status };
      }
      const { data } = await resp.json();
      return {
        models: sortModelsByRecency(
          (data || []).map(m => m.id).filter(id => id && !id.includes('embedding') && !id.includes('moderation'))
        ),
        source: 'api',
      };
    }
  } catch (e) {
    log('warn', 'AI models fetch exception', { provider, err: e.message });
  }

  return { models: STATIC_MODELS[provider] || [], source: 'static', reason: 'network_error' };
}

// Config mutável em runtime — alterável via POST /ai/settings sem restart
const runtimeConfig = {
  provider: process.env.AI_PROVIDER || 'mock',
  model:    process.env.AI_MODEL    || 'auto',
  apiKey:   process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '',
};

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(level, msg, extra = {}) {
  process.stdout.write(JSON.stringify({
    level, service: 'r-observe-ai', msg, ts: new Date().toISOString(), ...extra,
  }) + '\n');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const requireAuth = requireJwt;

// ─── Prompt ───────────────────────────────────────────────────────────────────
function buildPrompt(incident, context) {
  const lines = [
    '## Incidente Atual',
    `Título: ${incident.title || 'N/A'}`,
    `Severidade: ${incident.severity || 'N/A'}`,
    `Fonte: ${incident.source || 'N/A'}`,
  ];

  if (context?.event_output)  lines.push(`Output do check: ${context.event_output}`);
  if (context?.event_service) lines.push(`Serviço afetado: ${context.event_service}`);
  if (context?.host_address)  lines.push(`Endereço do host: ${context.host_address}`);

  const recentInc = context?.recent_incidents;
  if (recentInc?.length > 0) {
    lines.push('', '## Histórico do Host — apenas para identificar recorrência (NÃO use como evidência causal)');
    for (const inc of recentInc) {
      const dt = new Date(inc.created_at).toISOString().slice(0, 16).replace('T', ' ');
      const st = inc.resolved_at ? 'resolvido' : inc.status;
      lines.push(`- ${dt} | ${inc.title} | ${inc.severity} | ${st}`);
    }
    lines.push(`(${recentInc.length} incidente(s) recente(s) neste host — somente para avaliar recorrência)`);
  }

  const recentRem = context?.recent_remediations;
  if (recentRem?.length > 0) {
    lines.push('', '## Remediações Anteriores (últimos 7 dias)');
    for (const rem of recentRem) {
      const dt = new Date(rem.requested_at).toISOString().slice(0, 10);
      const reason = rem.reason ? ` — ${rem.reason}` : '';
      lines.push(`- ${dt}: ${rem.action}${reason} (status: ${rem.status})`);
    }
  }

  lines.push('', '## Catálogo de Referência (use como inspiração, não como limite)');
  for (const a of REMEDIATION_CATALOG) {
    lines.push(`- ${a.action} (risco: ${a.risk}) — ${a.description}`);
  }
  lines.push('Você pode sugerir ações fora deste catálogo se forem mais adequadas ao incidente.');

  lines.push(
    '',
    'Com base nas informações acima, responda SOMENTE em JSON válido com os campos:',
    '- summary (string): o que está acontecendo em 1-2 frases',
    '- cause (string): causa provável, referenciando o output do check se disponível',
    '- suggestion (string): ação recomendada, específica e acionável',
    '- severity_classification (string): "critical" | "warning" | "info"',
    '- recurrence (boolean): true se este tipo de falha já ocorreu recentemente',
    '- pattern (string | null): padrão identificado no histórico, ou null',
    '- remediation (object | null): { action, params, confidence_score (0.0-1.0), reasoning }',
    '  Use null se nenhuma ação for aplicável ou se não houver certeza suficiente.',
    '  confidence_score >= 0.85 dispara execução automática — seja conservador.',
  );

  return lines.join('\n');
}

// ─── Providers ────────────────────────────────────────────────────────────────
async function callOpenAI(prompt) {
  if (!runtimeConfig.apiKey) throw new Error('OPENAI_API_KEY not configured');
  const model = resolveModel('openai', runtimeConfig.model);
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${runtimeConfig.apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 600,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callDeepSeek(prompt) {
  if (!runtimeConfig.apiKey) throw new Error('DEEPSEEK_API_KEY not configured');
  const model = resolveModel('deepseek', runtimeConfig.model);

  // Tenta primeiro com response_format: json_object
  let resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${runtimeConfig.apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 800,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  let data = await resp.json();
  log('info', 'DeepSeek first attempt', { status: resp.status, ok: resp.ok, hasError: !!data.error, hasChoices: !!(data.choices?.length), model });

  // Se response_format não for suportado, a API pode retornar erro ou conteúdo vazio
  const content = data.choices?.[0]?.message?.content || '';
  const hasError = data.error || (!resp.ok);

  if (!hasError && !content) {
    log('warn', 'DeepSeek returned empty content with response_format, retrying without it');
    resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${runtimeConfig.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
        max_tokens: 800,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    data = await resp.json();
    log('info', 'DeepSeek retry (no response_format)', { status: resp.status, ok: resp.ok, hasChoices: !!(data.choices?.length) });
  }

  if (!resp.ok || data.error) {
    const errMsg = data.error?.message || data.error || `HTTP ${resp.status}`;
    throw new Error(`DeepSeek API error: ${errMsg}`);
  }

  const msg = data.choices?.[0]?.message || {};
  // Modelos reasoning (deepseek-reasoner, deepseek-v4-pro, o1, etc.) usam reasoning_content
  const finalContent = msg.content || msg.reasoning_content || '';
  const finishReason = data.choices?.[0]?.finish_reason || '';
  log('info', 'DeepSeek response', { model, content_length: finalContent.length, finish_reason: finishReason, has_reasoning: !!msg.reasoning_content, preview: finalContent.slice(0, 120) });
  if (!finalContent) {
    log('warn', 'DeepSeek empty response details', {
      finish_reason: finishReason,
      has_message: !!data.choices?.[0]?.message,
      message_keys: data.choices?.[0]?.message ? Object.keys(data.choices[0].message) : [],
      usage: data.usage || 'none',
    });
  }
  return finalContent;
}

async function callAnthropic(prompt) {
  if (!runtimeConfig.apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const model = resolveModel('anthropic', runtimeConfig.model);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': runtimeConfig.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

function mockAnalyze(incident, context) {
  const hasHistory = (context?.recent_incidents?.length ?? 0) > 0;
  const hasOutput  = !!context?.event_output;
  const hasPrevRem = (context?.recent_remediations?.length ?? 0) > 0;

  const cause = hasOutput
    ? `Output do check: "${context.event_output.slice(0, 120)}"`
    : 'Causa provável: falha no serviço ou recurso indisponível.';

  const suggestion = hasPrevRem
    ? `Ação anterior registrada: "${context.recent_remediations[0].action}". Verificar se ainda é aplicável.`
    : 'Verificar logs do serviço afetado e reiniciar se necessário.';

  const pattern = hasHistory
    ? `${context.recent_incidents.length} ocorrência(s) nos últimos 7 dias`
    : null;

  let mockRemediation = null;
  const title = (incident.title || '').toLowerCase();
  if (title.includes('container.stopped') || title.includes('container.unhealthy')) {
    const container = context?.event_service || 'unknown-container';
    mockRemediation = {
      action:           'docker:start',
      params:           { container },
      confidence_score: 0.72,
      reasoning:        '[MOCK] Container parado detectado. Score conservador — requer aprovação humana.',
    };
  } else if (incident.source === 'icinga' || title.includes('host.down') || title.includes('service.')) {
    mockRemediation = {
      action:           'icinga:reschedule',
      params:           { host: context?.host_address || 'unknown' },
      confidence_score: 0.90,
      reasoning:        '[MOCK] Reagendar check é seguro (risco nulo). Score alto.',
    };
  }

  return {
    summary:                `Incidente detectado: ${incident.title} com severidade ${incident.severity}.`,
    cause,
    suggestion,
    severity_classification: incident.severity || 'warning',
    recurrence:              hasHistory,
    pattern,
    remediation:             mockRemediation,
    provider: 'mock',
    model:    'mock-v1',
  };
}

// ─── Análise principal ────────────────────────────────────────────────────────
async function analyze(incident, context) {
  if (runtimeConfig.provider === 'mock') return mockAnalyze(incident, context);

  const prompt = buildPrompt(incident, context);
  const effectiveModel = resolveModel(runtimeConfig.provider, runtimeConfig.model);
  let raw = '';

  if (runtimeConfig.provider === 'openai')        raw = await callOpenAI(prompt);
  else if (runtimeConfig.provider === 'deepseek') raw = await callDeepSeek(prompt);
  else if (runtimeConfig.provider === 'anthropic') raw = await callAnthropic(prompt);
  else return mockAnalyze(incident, context);

  try {
    // Com response_format: json_object a resposta deve ser JSON puro
    const parsed = JSON.parse(raw);
    return {
      summary:                parsed.summary                || null,
      cause:                  parsed.cause                  || null,
      suggestion:             parsed.suggestion             || null,
      severity_classification: parsed.severity_classification || 'warning',
      recurrence:             parsed.recurrence             || false,
      pattern:                parsed.pattern                || null,
      remediation:            parsed.remediation            || null,
      provider:               runtimeConfig.provider,
      model:                  effectiveModel,
    };
  } catch {
    // Fallback: tenta extrair JSON de dentro de markdown ou texto
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          summary:                parsed.summary                || null,
          cause:                  parsed.cause                  || null,
          suggestion:             parsed.suggestion             || null,
          severity_classification: parsed.severity_classification || 'warning',
          recurrence:             parsed.recurrence             || false,
          pattern:                parsed.pattern                || null,
          remediation:            parsed.remediation            || null,
          provider:               runtimeConfig.provider,
          model:                  effectiveModel,
        };
      } catch { /* fallthrough */ }
    }
    return {
      summary:    raw.slice(0, 500),
      cause:      null,
      suggestion: null,
      provider:   runtimeConfig.provider,
      model:      effectiveModel,
    };
  }
}

/** Prompt para validação de mapeamento porta→serviço via IA. */
function buildServiceClassifyPrompt({ ip, port, current_label, http_banner, tcp_banner, hostname }) {
  const lines = [
    'Você é um especialista em redes e protocolos. Valide se o mapeamento de porta está correto.',
    '',
    `Host: ${ip}${hostname ? ` (${hostname})` : ''}`,
    `Porta: ${port}`,
    `Classificação atual: ${current_label || 'desconhecida'}`,
  ];
  if (http_banner) lines.push(`Resposta HTTP: ${String(http_banner).slice(0, 400)}`);
  if (tcp_banner) lines.push(`Banner TCP: ${String(tcp_banner).slice(0, 200)}`);

  lines.push(
    '',
    'Responda SOMENTE com JSON válido contendo:',
    '- service (string): nome real do serviço (ex: "IcingaWeb2", "nginx", "Prometheus", "Redis")',
    '- is_exporter (boolean): true se for endpoint de métricas Prometheus',
    '- exporter_job (string|null): nome do job Prometheus se for exporter',
    '- confidence (number): 0.0 a 1.0',
    '- reason (string): justificativa em 1 frase',
  );
  return lines.join('\n');
}

async function classifyServiceAI(params) {
  if (runtimeConfig.provider === 'mock') {
    return { service: params.current_label || `port-${params.port}`, confidence: 0.5, ai_fallback: true };
  }
  const prompt = buildServiceClassifyPrompt(params);
  let raw = '';
  try {
    if (runtimeConfig.provider === 'openai')        raw = await callOpenAI(prompt);
    else if (runtimeConfig.provider === 'deepseek') raw = await callDeepSeek(prompt);
    else if (runtimeConfig.provider === 'anthropic') raw = await callAnthropic(prompt);
    else return { service: params.current_label, confidence: 0.5, ai_fallback: true };

    const parsed = JSON.parse(raw);
    return { service: parsed.service || params.current_label, is_exporter: parsed.is_exporter || false,
      exporter_job: parsed.exporter_job || null, confidence: parsed.confidence || 0.6,
      reason: parsed.reason || null, provider: runtimeConfig.provider };
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { const p = JSON.parse(m[0]); return { service: p.service, is_exporter: p.is_exporter,
      exporter_job: p.exporter_job, confidence: p.confidence || 0.6, reason: p.reason }; } catch {} }
    return { service: params.current_label || `port-${params.port}`, confidence: 0.5, ai_fallback: true };
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '512kb' }));

const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });

app.get('/health', (_req, res) => {
  res.json({
    status:           'ok',
    service:          'r-observe-ai',
    provider:         runtimeConfig.provider,
    model:            runtimeConfig.model,
    effective_model:  resolveModel(runtimeConfig.provider, runtimeConfig.model),
    version:          '0.4.0',
  });
});

app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain');
  res.end([
    '# HELP r_observe_ai_analyses_total Total AI analyses performed',
    '# TYPE r_observe_ai_analyses_total counter',
    `r_observe_ai_analyses_total ${aiAnalysesCount}`,
    `# HELP r_observe_ai_incidents_stored Total incidents in memory`,
    '# TYPE r_observe_ai_incidents_stored gauge',
    `r_observe_ai_incidents_stored ${incidentStore.getStats().total}`,
  ].join('\n') + '\n');
});

// GET /ai/settings — config atual (sem expor a chave)
app.get('/ai/settings', requireAuth, (_req, res) => {
  res.json({
    provider:       runtimeConfig.provider,
    model:          runtimeConfig.model,
    effective_model: resolveModel(runtimeConfig.provider, runtimeConfig.model),
    has_api_key:    !!runtimeConfig.apiKey,
  });
});

// GET /ai/models — lista modelos disponíveis (API real ou fallback estático)
app.get('/ai/models', requireAuth, async (req, res) => {
  const provider = req.query.provider || runtimeConfig.provider;
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider inválido. Use: ${VALID_PROVIDERS.join(', ')}` });
  }
  const { models, source } = await fetchProviderModels(provider);
  res.json({ provider, models, auto: AUTO_MODELS[provider] || null, source });
});

// POST /ai/settings — atualiza provider/model/api_key em runtime
app.post('/ai/settings', requireAuth, requireScope('ai:settings:write'), (req, res) => {
  const { provider, model, api_key } = req.body;

  if (provider !== undefined) {
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider inválido. Use: ${VALID_PROVIDERS.join(', ')}` });
    }
    runtimeConfig.provider = provider;
  }
  if (model !== undefined) {
    runtimeConfig.model = model; // 'auto', '' ou nome explícito
  }
  if (api_key !== undefined) {
    runtimeConfig.apiKey = api_key;
  }

  log('info', 'Runtime config updated', {
    provider:      runtimeConfig.provider,
    model:         runtimeConfig.model,
    effective_model: resolveModel(runtimeConfig.provider, runtimeConfig.model),
  });

  res.json({
    ok:             true,
    provider:       runtimeConfig.provider,
    model:          runtimeConfig.model,
    effective_model: resolveModel(runtimeConfig.provider, runtimeConfig.model),
    has_api_key:    !!runtimeConfig.apiKey,
  });
});

// POST /ai/explain
app.post('/ai/explain', requireAuth, limiter, async (req, res) => {
  aiAnalysesCount++;
  const { incident, context } = req.body;
  if (!incident) return res.status(400).json({ error: 'incident é obrigatório' });
  try {
    log('info', 'Analyzing incident', { id: incident.id, provider: runtimeConfig.provider });
    const result = await analyze(incident, context);
    res.json(result);
  } catch (e) {
    log('error', 'AI analysis failed', { err: e.message });
    if (e.name === 'AbortError') return res.status(504).json({ error: 'AI provider timeout' });
    res.status(502).json({ error: 'AI analysis failed', detail: e.message });
  }
});

// POST /ai/classify
app.post('/ai/classify', requireAuth, limiter, async (req, res) => {
  const { event } = req.body;
  if (!event) return res.status(400).json({ error: 'event é obrigatório' });
  try {
    const incident = { title: event.type, severity: event.severity, source: event.source };
    const context  = { event_output: event.output || event.message };
    const result   = await analyze(incident, context);
    res.json({ severity: result.severity_classification || 'warning', analysis: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /ai/summarize
app.post('/ai/summarize', requireAuth, limiter, async (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events deve ser um array' });
  try {
    const incident = { title: `${events.length} eventos agregados`, severity: 'unknown', source: 'aggregated' };
    const context  = {
      event_output: events.slice(0, 10)
        .map(e => `[${e.type}] ${e.host || ''}: ${e.output || e.message || ''}`)
        .join('\n'),
    };
    const result = await analyze(incident, context);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /ai/fingerprint — identifica dispositivos desconhecidos por sinais passivos
app.post('/ai/fingerprint', requireAuth, limiter, async (req, res) => {
  const { signals } = req.body;
  if (!signals) return res.status(400).json({ error: 'signals é obrigatório' });

  try {
    const result = await fingerprintDevice(signals);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /ai/classify-service — valida mapeamento de porta/serviço via IA
app.post('/ai/classify-service', requireAuth, limiter, async (req, res) => {
  const { ip, port, current_label, http_banner, tcp_banner, hostname } = req.body;
  if (!ip || !port) return res.status(400).json({ error: 'ip e port são obrigatórios' });

  try {
    const result = await classifyServiceAI({ ip, port, current_label, http_banner, tcp_banner, hostname });
    res.json(result);
  } catch (e) {
    res.json({ service: current_label || `port-${port}`, confidence: 0.5, ai_fallback: true, error: e.message });
  }
});

/** Prompt para validação de mapeamento porta→serviço. */
function buildFingerprintPrompt(signals) {
  const lines = [
    'Você é um especialista em segurança de redes. Identifique o dispositivo de rede com base nos sinais passivos abaixo.',
    '',
    '## Sinais Observados',
  ];
  if (signals.mac)          lines.push(`MAC: ${signals.mac}`);
  if (signals.mac_vendor)   lines.push(`Fabricante pelo OUI: ${signals.mac_vendor}`);
  if (signals.hostname)     lines.push(`Hostname: ${signals.hostname}`);
  if (signals.ip)           lines.push(`IP: ${signals.ip}`);
  if (signals.open_ports?.length) lines.push(`Portas abertas: ${signals.open_ports.join(', ')}`);
  if (signals.mdns_services?.length) lines.push(`Serviços mDNS: ${signals.mdns_services.join(', ')}`);
  if (signals.ssdp_server)  lines.push(`SSDP Server: ${signals.ssdp_server}`);
  if (signals.txt_manufacturer) lines.push(`Fabricante (TXT): ${signals.txt_manufacturer}`);
  if (signals.txt_model)    lines.push(`Modelo (TXT): ${signals.txt_model}`);
  if (signals.txt_friendly_name) lines.push(`Nome amigável: ${signals.txt_friendly_name}`);
  if (signals.raw_mdns)     lines.push(`mDNS raw (trecho): ${String(signals.raw_mdns).slice(0, 300)}`);
  if (signals.raw_ssdp)     lines.push(`SSDP raw (trecho): ${String(signals.raw_ssdp).slice(0, 300)}`);

  lines.push(
    '',
    'Responda SOMENTE com JSON válido contendo:',
    '- vendor (string): fabricante do dispositivo, ou null se desconhecido',
    '- product (string): nome do produto/modelo, ou null se desconhecido',
    '- category (string): uma de: mobile, media, iot, host, router, switch, ap, printer, camera, voice, unknown',
    '- technology (string): tecnologia principal (ex: android, ios, linux, windows, upnp-media, etc.), ou null',
    '- asset_type (string): uma de: mobile, media_device, iot, host, network_device',
    '- confidence (number): 0.0 a 1.0 — sua confiança na classificação',
    '- reasoning (string): explicação em 1 frase do que levou à identificação',
  );
  return lines.join('\n');
}

/** Mock para quando provider = mock. */
function mockFingerprintDevice(signals) {
  const raw = [
    signals.ssdp_server, signals.txt_manufacturer, signals.txt_model,
    signals.hostname, (signals.mdns_services || []).join(' '), signals.raw_mdns,
  ].filter(Boolean).join(' ').toLowerCase();

  if (raw.includes('hisense') || raw.includes('smarttv') || raw.includes('airplay')) {
    return { vendor: signals.txt_manufacturer || 'Hisense', product: signals.txt_model || 'Smart TV', category: 'media', technology: 'upnp-media', asset_type: 'media_device', confidence: 0.85, reasoning: '[MOCK] Detectado por AirPlay/Hisense', provider: 'mock', model: 'mock-v1' };
  }
  if (raw.includes('linux') || raw.includes('avahi')) {
    return { vendor: 'Linux', product: 'Linux Host', category: 'host', technology: 'linux', asset_type: 'host', confidence: 0.80, reasoning: '[MOCK] Detectado por stack Linux/Avahi', provider: 'mock', model: 'mock-v1' };
  }
  if (raw.includes('googlecast') || raw.includes('motorola') || raw.includes('android')) {
    return { vendor: signals.txt_manufacturer || 'Motorola', product: signals.txt_model || 'Smartphone Android', category: 'mobile', technology: 'android', asset_type: 'mobile', confidence: 0.82, reasoning: '[MOCK] Detectado por Google Cast/Android', provider: 'mock', model: 'mock-v1' };
  }
  return { vendor: null, product: null, category: 'unknown', technology: null, asset_type: 'iot', confidence: 0.2, reasoning: '[MOCK] Sinais insuficientes para identificação', provider: 'mock', model: 'mock-v1' };
}

async function fingerprintDevice(signals) {
  if (runtimeConfig.provider === 'mock') return mockFingerprintDevice(signals);

  const prompt = buildFingerprintPrompt(signals);
  const effectiveModel = resolveModel(runtimeConfig.provider, runtimeConfig.model);
  let raw = '';

  if (runtimeConfig.provider === 'openai')         raw = await callOpenAI(prompt);
  else if (runtimeConfig.provider === 'deepseek')  raw = await callDeepSeek(prompt);
  else if (runtimeConfig.provider === 'anthropic') raw = await callAnthropic(prompt);
  else return mockFingerprintDevice(signals);

  try {
    const parsed = JSON.parse(raw);
    return { ...parsed, provider: runtimeConfig.provider, model: effectiveModel };
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return { ...JSON.parse(match[0]), provider: runtimeConfig.provider, model: effectiveModel }; } catch { /* fallthrough */ }
    }
    return { summary: raw.slice(0, 300), provider: runtimeConfig.provider, model: effectiveModel };
  }
}

// ─── AIOps Endpoints ──────────────────────────────────────────────────────

// POST /ai/rca — Root Cause Analysis
app.post('/ai/rca', requireAuth, limiter, async (req, res) => {
  const { incident, topology, recent_events, similar_incidents } = req.body;
  if (!incident) return res.status(400).json({ error: 'incident é obrigatório' });
  try {
    const result = analyzeRootCause(incident, {
      topology: topology || [],
      recent_events: recent_events || [],
      similar_incidents: similar_incidents || [],
    });

    // Store in incident memory for future similarity searches
    incidentStore.add({
      id: incident.id,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      source: incident.source,
      check_type: incident.check_type,
      target_type: incident.target_type,
      target_name: incident.target_name,
      target_id: incident.target_id,
      host_name: incident.host_name,
      description: incident.description,
      ai_summary: result.best_hypothesis?.cause || null,
      created_at: incident.timestamp || incident.created_at || new Date().toISOString(),
      resolved_cause: null,
    });

    res.json(result);
  } catch (e) {
    log('error', 'RCA failed', { err: e.message });
    res.status(500).json({ error: 'RCA analysis failed', detail: e.message });
  }
});

// POST /ai/correlate — Event Correlation
app.post('/ai/correlate', requireAuth, limiter, async (req, res) => {
  const { events, mode } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events deve ser um array' });
  try {
    let result;

    switch (mode) {
      case 'dedup': {
        const dedupResult = deduplicateAlerts(events);
        result = { ...dedupResult, mode: 'dedup' };
        break;
      }
      case 'cluster': {
        const clusters = clusterEvents(events);
        result = { clusters, total_clusters: clusters.length, mode: 'cluster' };
        break;
      }
      case 'patterns': {
        const patterns = detectPatterns(events);
        result = { patterns, total_patterns: patterns.length, mode: 'patterns' };
        break;
      }
      default: {
        // Full correlation: dedup + cluster + patterns
        const dedupResult = deduplicateAlerts(events);
        const clusters = clusterEvents(events);
        const patterns = detectPatterns(events);
        result = {
          dedup: { unique_count: dedupResult.unique_count, dedup_count: dedupResult.dedup_count },
          clusters: clusters.slice(0, 10),
          total_clusters: clusters.length,
          patterns,
          total_patterns: patterns.length,
          mode: 'full',
        };
      }
    }

    res.json(result);
  } catch (e) {
    log('error', 'Correlation failed', { err: e.message });
    res.status(500).json({ error: 'Correlation failed', detail: e.message });
  }
});

// POST /ai/similar-incidents — Find similar incidents
app.post('/ai/similar-incidents', requireAuth, limiter, async (req, res) => {
  const { incident, min_similarity, max_results } = req.body;
  if (!incident) return res.status(400).json({ error: 'incident é obrigatório' });
  try {
    const results = incidentStore.search(incident, {
      minSimilarity: min_similarity || 0.3,
      maxResults: max_results || 10,
    });

    res.json({
      similar_incidents: results,
      total: results.length,
      searched_at: new Date().toISOString(),
    });
  } catch (e) {
    log('error', 'Similar incident search failed', { err: e.message });
    res.status(500).json({ error: 'Search failed', detail: e.message });
  }
});

// GET /ai/playbooks — Search knowledge base playbooks
app.get('/ai/playbooks', requireAuth, async (req, res) => {
  const { check_type, severity, target_type, source, status } = req.query;
  const incident = {
    check_type: check_type || null,
    severity: severity || null,
    target_type: target_type || null,
    source: source || null,
    status: status || null,
  };

  try {
    const results = findPlaybooks(incident);
    res.json({
      playbooks: results.map(r => ({
        id: r.playbook.id,
        title: r.playbook.title,
        relevance: r.relevance,
        risk: r.playbook.risk,
        auto_ok: r.playbook.auto_ok,
        estimated_time_minutes: r.playbook.estimated_time_minutes,
        steps: r.playbook.steps,
      })),
      total: results.length,
    });
  } catch (e) {
    res.status(500).json({ error: 'Playbook search failed', detail: e.message });
  }
});

// POST /ai/feedback — Record feedback on remediation
app.post('/ai/feedback', requireAuth, limiter, async (req, res) => {
  const { incident_id, remediation_id, rating, comment } = req.body;
  if (!incident_id || !remediation_id || rating === undefined) {
    return res.status(400).json({ error: 'incident_id, remediation_id e rating são obrigatórios' });
  }
  try {
    feedbackLoop.record(incident_id, remediation_id, parseInt(rating), comment || null);

    // Update incident memory with resolution
    const incident = incidentStore.get(incident_id);
    if (incident) {
      incident.resolved_cause = comment || `Resolved via ${remediation_id} (rating: ${rating})`;
    }

    res.json({
      ok: true,
      stats: feedbackLoop.getStats(),
    });
  } catch (e) {
    res.status(500).json({ error: 'Feedback recording failed', detail: e.message });
  }
});

// GET /ai/feedback/stats — Feedback statistics
app.get('/ai/feedback/stats', requireAuth, async (req, res) => {
  try {
    const remediationId = req.query.remediation_id || null;
    if (remediationId) {
      const effectiveness = feedbackLoop.getEffectiveness(remediationId);
      res.json({ remediation_id: remediationId, effectiveness });
    } else {
      res.json(feedbackLoop.getStats());
    }
  } catch (e) {
    res.status(500).json({ error: 'Stats retrieval failed', detail: e.message });
  }
});

// GET /ai/incidents/stats — Incident store statistics
app.get('/ai/incidents/stats', requireAuth, async (_req, res) => {
  try {
    res.json(incidentStore.getStats());
  } catch (e) {
    res.status(500).json({ error: 'Stats retrieval failed', detail: e.message });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', `AI service listening on :${PORT}`, {
    provider:      runtimeConfig.provider,
    model:         runtimeConfig.model,
    effective_model: resolveModel(runtimeConfig.provider, runtimeConfig.model),
  });
});

const lifecycle = createLifecycle({ label: 'r-observe-ai', log });
lifecycle.onServer(server);
lifecycle.start();
