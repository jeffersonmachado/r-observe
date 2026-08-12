'use strict';

/**
 * Alerting Engine Integrado — sistema de alertas nativo do R-Observe.
 *
 * Antes (gap): dependência exclusiva do Icinga2 para alertas.
 * Agora: alert rules, templates, transports e acknowledgment nativos.
 *
 * Funcionalidades:
 *   - Alert rules com condições (threshold, absence, rate, delta)
 *   - Templates customizáveis (title, body)
 *   - Transports: email, webhook, Redis event
 *   - Deduplication (fingerprint-based)
 *   - Severity: critical, warning, info, ok (recovery)
 *   - Acknowledgment + maintenance windows
 *   - Integração com Icinga2 (compatível, não substituto)
 */

const { log } = require('../utils/logger');
const { emitEvent } = require('../queues/events');

// ── Transports ──────────────────────────────────────────────────────────────

const transports = {
  /**
   * Email transport.
   */
  async email(alert, config) {
    const { spawn } = require('child_process');

    const subject = `[${alert.severity.toUpperCase()}] ${alert.rule_name}: ${alert.summary}`;
    const body = buildEmailBody(alert);
    const to = config.to || process.env.ALERT_EMAIL_TO || 'admin@localhost';
    if (!/^[a-zA-Z0-9_.+@-]{1,254}$/.test(to) || /[\r\n]/.test(subject)) return false;

    try {
      await new Promise((resolve, reject) => {
        const child = spawn('mail', ['-s', subject, to], { stdio: ['pipe', 'ignore', 'ignore'] });
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('mail timeout')); }, 10000);
        child.once('error', (e) => { clearTimeout(timer); reject(e); });
        child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`mail exit ${code}`)); });
        child.stdin.end(body);
      });
      return true;
    } catch (e) {
      log('error', 'Alert email failed', { err: e.message });
      return false;
    }
  },

  /**
   * Webhook transport (Slack, Discord, custom).
   */
  async webhook(alert, config) {
    const https = require('https');
    const http = require('http');
    const url = new URL(config.url);

    const payload = JSON.stringify({
      rule_name: alert.rule_name,
      severity: alert.severity,
      summary: alert.summary,
      description: alert.description,
      host: alert.host,
      metric: alert.metric,
      value: alert.value,
      threshold: alert.threshold,
      timestamp: alert.timestamp,
      fingerprint: alert.fingerprint,
    });

    return new Promise((resolve) => {
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      }, (res) => resolve(res.statusCode >= 200 && res.statusCode < 300));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    });
  },

  /**
   * Redis event transport — emite no bus interno para workers/Icinga.
   */
  async redisEvent(alert, config) {
    try {
      await emitEvent('observe:alerts', {
        type: 'observe.alert.fired',
        alert,
        ts: new Date().toISOString(),
      });
      return true;
    } catch (e) {
      log('warn', 'Alert redis event failed', { err: e.message });
      return false;
    }
  },
};

// ── Rule Evaluator ──────────────────────────────────────────────────────────

/**
 * Avalia uma condição contra um valor.
 *
 * Operadores suportados:
 *   - gt, gte, lt, lte, eq, neq
 *   - absent (valor é null/undefined)
 *   - rate (delta por segundo)
 *   - pct (percentual)
 */
function evaluateCondition(condition, value, context = {}) {
  const { operator, threshold, compare_value } = condition;

  if (value === null || value === undefined) {
    if (operator === 'absent') return true;
    return false;
  }

  const numVal = Number(value);
  const numThreshold = Number(threshold ?? compare_value);

  if (isNaN(numVal)) {
    // String comparison
    switch (operator) {
      case 'eq':  return String(value) === String(threshold);
      case 'neq': return String(value) !== String(threshold);
      case 'contains': return String(value).includes(String(threshold));
      default: return false;
    }
  }

  switch (operator) {
    case 'gt':  return numVal > numThreshold;
    case 'gte': return numVal >= numThreshold;
    case 'lt':  return numVal < numThreshold;
    case 'lte': return numVal <= numThreshold;
    case 'eq':  return numVal === numThreshold;
    case 'neq': return numVal !== numThreshold;

    // Rate: (current - previous) / interval_seconds
    case 'rate': {
      const prev = Number(context.previous_value || 0);
      const interval = Math.max(Number(context.interval_seconds || 300), 1);
      const rate = (numVal - prev) / interval;
      return rate > (numThreshold || 0);
    }

    // Percentual: (value / total) * 100
    case 'pct': {
      const total = Number(context.total || 100);
      if (total <= 0) return false;
      const pct = (numVal / total) * 100;
      return pct > (numThreshold || 90);
    }

    default:
      log('warn', `Unknown alert condition operator: ${operator}`);
      return false;
  }
}

/**
 * Avalia uma rule contra os dados atuais.
 */
function evaluateRule(rule, data, context) {
  const results = [];

  for (const condition of rule.conditions || []) {
    const metric = condition.metric || condition.field;
    const value = data[metric];

    const matched = evaluateCondition(condition, value, {
      ...context,
      previous_value: context.previous?.[metric],
      total: context.totals?.[metric],
    });

    results.push({
      metric,
      value,
      condition,
      matched,
    });
  }

  const allMatched = rule.logic === 'or'
    ? results.some(r => r.matched)
    : results.every(r => r.matched); // 'and' (default)

  return {
    rule,
    fired: allMatched,
    results,
    timestamp: new Date().toISOString(),
  };
}

// ── Dedup ───────────────────────────────────────────────────────────────────

/**
 * Gera fingerprint única para dedup de alerta.
 */
function generateFingerprint(rule, data) {
  const crypto = require('crypto');
  const key = `${rule.name}:${data.host || data.asset_key || ''}:${data.metric || ''}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ── Alert Builder ───────────────────────────────────────────────────────────

function buildAlert(rule, evalResult, data) {
  const severity = determineSeverity(rule, evalResult);
  const summary = interpolateTemplate(rule.title || rule.name, data, evalResult);
  const description = interpolateTemplate(rule.description || '', data, evalResult);
  const fingerprint = generateFingerprint(rule, data);

  return {
    rule_name: rule.name,
    rule_id: rule.id || rule.name,
    severity,
    summary,
    description,
    host: data.host || data.asset_key || null,
    asset_id: data.asset_id || null,
    metric: evalResult.results.find(r => r.matched)?.metric || null,
    value: evalResult.results.find(r => r.matched)?.value || null,
    threshold: evalResult.results.find(r => r.matched)?.condition?.threshold || null,
    fingerprint,
    timestamp: evalResult.timestamp,
    eval_results: evalResult.results,
  };
}

function determineSeverity(rule, evalResult) {
  // Se é recovery
  if (evalResult.recovery) return 'ok';

  const firstMatch = evalResult.results.find(r => r.matched);
  if (firstMatch?.condition?.severity) return firstMatch.condition.severity;

  return rule.severity || 'warning';
}

function interpolateTemplate(template, data, evalResult) {
  return String(template || '')
    .replace(/\{\{host\}\}/g, data.host || 'unknown')
    .replace(/\{\{metric\}\}/g, evalResult.results.find(r => r.matched)?.metric || '')
    .replace(/\{\{value\}\}/g, evalResult.results.find(r => r.matched)?.value || '')
    .replace(/\{\{threshold\}\}/g, evalResult.results.find(r => r.matched)?.condition?.threshold || '')
    .replace(/\{\{severity\}\}/g, determineSeverity({ severity: 'warning' }, evalResult));
}

function buildEmailBody(alert) {
  return [
    `Alert: ${alert.rule_name}`,
    `Severity: ${alert.severity}`,
    `Host: ${alert.host}`,
    `Metric: ${alert.metric} = ${alert.value}`,
    `Threshold: ${alert.threshold}`,
    `Time: ${alert.timestamp}`,
    ``,
    alert.description || '',
  ].join('\n');
}

// ── Main Engine ─────────────────────────────────────────────────────────────

/**
 * Motor de alertas principal.
 *
 * @param {Array} rules - lista de regras de alerta
 * @param {object} data - dados do asset/métrica
 * @param {object} context - { previous, totals, interval_seconds }
 * @param {object} dbConn - conexão PostgreSQL (para dedup e persistência)
 */
async function evaluateAlerts(rules, data, context = {}, dbConn = null) {
  const firedAlerts = [];

  for (const rule of rules) {
    const evalResult = evaluateRule(rule, data, context);

    if (!evalResult.fired) {
      // Verifica recovery: alerta que estava ativo e agora não está mais
      if (dbConn) {
        await checkRecovery(rule, data, dbConn, context);
      }
      continue;
    }

    const alert = buildAlert(rule, evalResult, data);

    // Dedup: não dispara o mesmo alerta duas vezes
    if (dbConn) {
      const alreadyFired = await isAlertActive(dbConn, alert.fingerprint, context);
      if (alreadyFired) continue;
    }

    // Dispara transports
    const transportResults = {};
    for (const transport of rule.transports || ['redisEvent']) {
      const transportFn = transports[transport];
      if (!transportFn) continue;

      const config = rule.transport_config?.[transport] || {};
      transportResults[transport] = await transportFn(alert, config);
    }

    alert.transports = transportResults;

    // Persiste
    if (dbConn) {
      await persistAlert(dbConn, alert, data, context);
    }

    firedAlerts.push(alert);
  }

  return firedAlerts;
}

async function isAlertActive(dbConn, fingerprint, context = {}) {
  try {
    const { rows } = await dbConn.query(
      `SELECT 1 FROM observe_alerts
       WHERE fingerprint = $1 AND tenant_id=$2 AND site_id=$3 AND edge_id=$4 AND severity != 'ok' AND resolved_at IS NULL`,
      [fingerprint, context.tenant_id || 'default', context.site_id || 'default-site', context.edge_id || 'central']
    );
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

async function checkRecovery(rule, data, dbConn, context) {
  try {
    const fingerprint = generateFingerprint(rule, data);
    await dbConn.query(
      `UPDATE observe_alerts SET severity = 'ok', resolved_at = NOW()
       WHERE fingerprint = $1 AND tenant_id=$2 AND site_id=$3 AND edge_id=$4 AND severity != 'ok' AND resolved_at IS NULL`,
      [fingerprint, context.tenant_id || 'default', context.site_id || 'default-site', context.edge_id || 'central']
    );
  } catch (e) {
    // Ignora erros de recovery
  }
}

async function persistAlert(dbConn, alert, data, context = {}) {
  try {
    await dbConn.query(
      `INSERT INTO observe_alerts
       (tenant_id, site_id, edge_id, rule_name, rule_id, severity, summary, description, host, asset_id,
        metric, value, threshold, fingerprint, eval_results, fired_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (tenant_id, site_id, edge_id, fingerprint) WHERE resolved_at IS NULL DO NOTHING`,
      [
        context.tenant_id || 'default', context.site_id || 'default-site', context.edge_id || 'central',
        alert.rule_name, alert.rule_id, alert.severity,
        alert.summary, alert.description, alert.host, alert.asset_id,
        alert.metric, alert.value, alert.threshold, alert.fingerprint,
        JSON.stringify(alert.eval_results),
      ]
    );
  } catch (e) {
    log('warn', 'Failed to persist alert', { err: e.message });
  }
}

// ── Built-in Rules ──────────────────────────────────────────────────────────

/**
 * Regras padrão de alerta.
 */
const BUILTIN_RULES = [
  {
    name: 'host_down',
    title: '{{host}} is DOWN',
    description: 'Host {{host}} is not responding to SNMP or ping.',
    severity: 'critical',
    logic: 'and',
    conditions: [
      { metric: 'snmp_up', operator: 'eq', threshold: 0 },
    ],
    transports: ['redisEvent', 'email'],
  },
  {
    name: 'interface_down',
    title: 'Interface {{metric}} is DOWN on {{host}}',
    description: 'Interface operational status changed to down.',
    severity: 'critical',
    logic: 'and',
    conditions: [
      { metric: 'if_oper_status', operator: 'eq', threshold: 2 },
    ],
    transports: ['redisEvent', 'email'],
  },
  {
    name: 'cpu_high',
    title: 'CPU usage > {{threshold}}% on {{host}}',
    description: 'CPU idle is below threshold.',
    severity: 'warning',
    logic: 'and',
    conditions: [
      { metric: 'cpu_idle_pct', operator: 'lt', threshold: 10, severity: 'critical' },
      { metric: 'cpu_idle_pct', operator: 'lt', threshold: 25, severity: 'warning' },
    ],
    transports: ['redisEvent'],
  },
  {
    name: 'memory_high',
    title: 'Memory usage > {{threshold}}% on {{host}}',
    description: 'Available memory is below threshold.',
    severity: 'warning',
    logic: 'or',
    conditions: [
      { metric: 'memory_used_pct', operator: 'gte', threshold: 95, severity: 'critical' },
      { metric: 'memory_used_pct', operator: 'gte', threshold: 90, severity: 'warning' },
    ],
    transports: ['redisEvent', 'email'],
  },
  {
    name: 'storage_high',
    title: 'Storage usage > {{threshold}}% on {{host}}',
    description: 'Storage is nearly full.',
    severity: 'warning',
    logic: 'or',
    conditions: [
      { metric: 'storage_used_pct', operator: 'gte', threshold: 95, severity: 'critical' },
      { metric: 'storage_used_pct', operator: 'gte', threshold: 90, severity: 'warning' },
    ],
    transports: ['redisEvent'],
  },
  {
    name: 'interface_errors',
    title: 'Interface errors detected on {{host}}',
    description: 'Input or output errors increasing.',
    severity: 'warning',
    logic: 'or',
    conditions: [
      { metric: 'if_in_errors', operator: 'rate', threshold: 0.5, severity: 'warning' },
      { metric: 'if_out_errors', operator: 'rate', threshold: 0.5, severity: 'warning' },
    ],
    transports: ['redisEvent'],
  },
  {
    name: 'bgp_peer_down',
    title: 'BGP peer {{metric}} is DOWN on {{host}}',
    description: 'BGP session is not established.',
    severity: 'critical',
    logic: 'and',
    conditions: [
      { metric: 'bgp_state', operator: 'neq', threshold: 'established' },
    ],
    transports: ['redisEvent', 'email'],
  },
  {
    name: 'config_changed',
    title: 'Configuration changed on {{host}}',
    description: 'Running configuration has been modified.',
    severity: 'info',
    logic: 'and',
    conditions: [
      { metric: 'config_changed', operator: 'eq', threshold: true },
    ],
    transports: ['redisEvent', 'email'],
  },
];

module.exports = { evaluateAlerts, BUILTIN_RULES, transports, evaluateRule, evaluateCondition, generateFingerprint };
