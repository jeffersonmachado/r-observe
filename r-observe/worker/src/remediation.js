'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const icinga = require('./icinga');

const execFileAsync = promisify(execFile);

// ─── Config ───────────────────────────────────────────────────────────────────
const AUTO_THRESHOLD    = parseFloat(process.env.REMEDIATION_AUTO_THRESHOLD    || '0.85');
const MAX_AUTO_SEVERITY = (process.env.REMEDIATION_MAX_AUTO_SEVERITY           || 'warning').toLowerCase();

const ALLOWED_CONTAINERS = new Set(
  (process.env.REMEDIATION_ALLOWED_CONTAINERS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

const SEVERITY_ORDER = { critical: 3, warning: 2, info: 1, unknown: 0 };

// ─── Catálogo dinâmico carregado do DB ───────────────────────────────────────
// Substituído por loadCatalogFromDb() na inicialização do worker.
let _dbCatalogMeta = {};  // action → { description, risk, params, auto_ok, max_severity }

function setCatalogMeta(rows) {
  _dbCatalogMeta = {};
  for (const row of rows) {
    _dbCatalogMeta[row.action] = row;
  }
}

function getCatalogMeta(action) {
  return _dbCatalogMeta[action] || null;
}

// ─── Validações ───────────────────────────────────────────────────────────────
function validateContainerName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
    throw new Error(`Nome de container inválido: "${name}"`);
  if (ALLOWED_CONTAINERS.size === 0)
    throw new Error('Remediação Docker bloqueada. Defina REMEDIATION_ALLOWED_CONTAINERS no .env.observe.');
  if (!ALLOWED_CONTAINERS.has(name))
    throw new Error(`Container "${name}" não está em REMEDIATION_ALLOWED_CONTAINERS.`);
}

function validateUrl(url) {
  if (!/^https?:\/\/[^\s]{4,}/.test(url))
    throw new Error(`URL inválida para verificação: "${url}"`);
}

// ─── Catálogo de ações (implementações) ──────────────────────────────────────
const CATALOG = {

  'icinga:reschedule': {
    description: 'Reagenda um check no Icinga2',
    risk: 'none', params: ['host', 'service?'],
    async execute({ host, service }) {
      if (!host) throw new Error('"host" é obrigatório');
      const r = await icinga.rescheduleCheck(host, service || null);
      return { success: r.ok, output: r.output };
    },
  },

  'icinga:add-host': {
    description: 'Registra host descoberto no Icinga2',
    risk: 'low', params: ['name', 'address', 'display_name?'],
    async execute({ name, address, display_name }) {
      if (!name || !address) throw new Error('"name" e "address" são obrigatórios');
      const r = await icinga.registerHost(name, address, display_name || name, {});
      return { success: r.ok, output: r.existed ? `host atualizado: ${name}` : `host registrado: ${name}` };
    },
  },

  // Cria downtime (silencia alertas) para um host no Icinga2
  'icinga:silence': {
    description: 'Cria downtime no Icinga2 silenciando alertas do host',
    risk: 'low', params: ['host', 'duration_minutes?', 'comment?'],
    async execute({ host, duration_minutes, comment }) {
      if (!host) throw new Error('"host" é obrigatório');
      const mins = parseInt(duration_minutes || 60, 10);
      const now  = Math.floor(Date.now() / 1000);
      const r = await icinga.request('POST', '/actions/schedule-downtime', {
        type:       'Host',
        filter:     `host.name=="${host}"`,
        start_time: now,
        end_time:   now + mins * 60,
        duration:   mins * 60,
        author:     'r-observe-ai',
        comment:    comment || `Auto-silence por ${mins} min — R-Observe AI`,
        fixed:      true,
      });
      return { success: r.ok, output: `downtime agendado para ${host} por ${mins} min (HTTP ${r.status})` };
    },
  },

  // Adiciona comentário a host ou serviço no Icinga2
  'icinga:add-comment': {
    description: 'Adiciona comentário a host/serviço no Icinga2',
    risk: 'none', params: ['host', 'comment', 'service?'],
    async execute({ host, comment, service }) {
      if (!host || !comment) throw new Error('"host" e "comment" são obrigatórios');
      const type   = service ? 'Service' : 'Host';
      const filter = service ? `host.name=="${host}" && service.name=="${service}"` : `host.name=="${host}"`;
      const r = await icinga.request('POST', '/actions/add-comment', {
        type, filter, author: 'r-observe-ai', comment,
      });
      return { success: r.ok, output: `comentário adicionado a ${host}${service ? '/' + service : ''}` };
    },
  },

  'http:verify': {
    description: 'Verifica se um endpoint HTTP está respondendo',
    risk: 'none', params: ['url'],
    async execute({ url }) {
      validateUrl(url);
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return { success: resp.ok, output: `HTTP ${resp.status} em ${url}` };
    },
  },

  'docker:start': {
    description: 'Inicia um container Docker parado',
    risk: 'low', params: ['container'],
    async execute({ container }) {
      validateContainerName(container);
      const { stdout, stderr } = await execFileAsync('docker', ['start', container], { timeout: 30_000 });
      return { success: true, output: (stdout || stderr || '').trim() };
    },
  },

  'docker:restart': {
    description: 'Reinicia um container Docker',
    risk: 'medium', params: ['container'],
    async execute({ container }) {
      validateContainerName(container);
      const { stdout, stderr } = await execFileAsync('docker', ['restart', container], { timeout: 60_000 });
      return { success: true, output: (stdout || stderr || '').trim() };
    },
  },

  'docker:stop': {
    description: 'Para um container Docker',
    risk: 'high', params: ['container'],
    async execute({ container }) {
      validateContainerName(container);
      const { stdout, stderr } = await execFileAsync('docker', ['stop', container], { timeout: 60_000 });
      return { success: true, output: (stdout || stderr || '').trim() };
    },
  },
};

// ─── API pública ──────────────────────────────────────────────────────────────

function isActionAllowed(action) {
  const meta = getCatalogMeta(action);
  // Habilitado no DB (se carregado) ou existe no catálogo embutido
  if (meta) return meta.enabled !== false;
  return action in CATALOG;
}

function canAutoExecute(action, confidenceScore, incidentSeverity) {
  if (!isActionAllowed(action)) return false;
  if (confidenceScore < AUTO_THRESHOLD) return false;

  // Respeita max_severity do DB quando disponível
  const meta = getCatalogMeta(action);
  const maxSev = meta?.max_severity || MAX_AUTO_SEVERITY;

  const sev = (incidentSeverity || 'unknown').toLowerCase();
  return (SEVERITY_ORDER[sev] ?? 0) <= (SEVERITY_ORDER[maxSev] ?? 0);
}

async function executeAction(action, params) {
  if (!isActionAllowed(action))
    return { success: false, output: `Ação "${action}" não existe ou está desabilitada.` };
  if (!(action in CATALOG))
    return { success: false, output: `Ação "${action}" não tem implementação.` };
  try {
    return await CATALOG[action].execute(params || {});
  } catch (e) {
    return { success: false, output: e.message };
  }
}

function catalogDescription() {
  // Usa metadados do DB quando disponíveis; fallback para os embutidos
  return Object.entries(CATALOG).map(([key, val]) => {
    const meta = getCatalogMeta(key);
    return {
      action:      key,
      description: meta?.description || val.description,
      risk:        meta?.risk        || val.risk,
      params:      meta?.params      || val.params,
      enabled:     meta ? meta.enabled : true,
    };
  }).filter(a => a.enabled !== false);
}

module.exports = {
  isActionAllowed,
  canAutoExecute,
  executeAction,
  catalogDescription,
  setCatalogMeta,
  getCatalogMeta,
  CATALOG,
  AUTO_THRESHOLD,
  MAX_AUTO_SEVERITY,
};
