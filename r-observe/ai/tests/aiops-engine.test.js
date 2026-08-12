'use strict';

/**
 * R-Observe — AIOps Engine Tests
 *
 * Cobertura:
 *   - Root Cause Analysis
 *   - Event Correlation
 *   - Incident Memory
 *   - Knowledge Base
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// ─── Root Cause Analysis ─────────────────────────────────────────────────────

const { analyzeRootCause, DOMAIN_RULES } = require('../src/root-cause-engine');

describe('Root Cause Analysis Engine', () => {
  it('deve aplicar regras de domínio para database cascade', () => {
    const incident = {
      id: 'inc-1',
      title: 'MySQL down',
      severity: 'critical',
      target_type: 'database',
      target_name: 'mysql-main',
      target_id: 'mysql-main',
      source: 'icinga',
      check_type: 'tcp',
    };

    const topology = [
      { source: 'api-service', target: 'mysql-main', dependency_type: 'service_database' },
      { source: 'worker', target: 'mysql-main', dependency_type: 'service_database' },
    ];

    const result = analyzeRootCause(incident, { topology, recent_events: [], similar_incidents: [] });

    assert.ok(result.best_hypothesis);
    assert.ok(result.best_hypothesis.cause.includes('mysql-main'));
    assert.ok(result.impacted_systems.includes('api-service'));
    assert.ok(result.impacted_systems.includes('worker'));
  });

  it('deve detectar network partition', () => {
    const incident = {
      id: 'inc-2',
      title: 'Switch core down',
      severity: 'down',
      target_type: 'switch',
      target_name: 'core-sw-01',
      target_id: 'core-sw-01',
      source: 'icinga',
      check_type: 'hostalive',
    };

    const topology = [
      { source: 'core-sw-01', target: 'server-01', dependency_type: 'network_path', path: ['core-sw-01'] },
      { source: 'core-sw-01', target: 'server-02', dependency_type: 'network_path', path: ['core-sw-01'] },
    ];

    const result = analyzeRootCause(incident, { topology, recent_events: [], similar_incidents: [] });

    assert.ok(result.best_hypothesis);
    assert.ok(result.best_hypothesis.type.includes('network_partition'));
    assert.ok(result.impacted_systems.includes('server-01'));
  });

  it('deve sugerir ações para disco cheio', () => {
    const incident = {
      id: 'inc-3',
      title: 'Disk warning on server-01',
      severity: 'critical',
      target_type: 'server',
      target_name: 'server-01',
      target_id: 'server-01',
      source: 'icinga',
      check_type: 'disk',
    };

    const result = analyzeRootCause(incident, { topology: [], recent_events: [], similar_incidents: [] });

    assert.ok(result.best_hypothesis);
    assert.ok(result.suggested_actions.length > 0);
  });

  it('deve retornar hipóteses ordenadas por confiança', () => {
    const incident = {
      id: 'inc-4',
      title: 'Database down on mysql-01',
      severity: 'critical',
      target_type: 'database',
      target_name: 'mysql-01',
      target_id: 'mysql-01',
      source: 'icinga',
      check_type: 'tcp',
      timestamp: new Date().toISOString(),
    };

    const topology = [
      { source: 'web-app', target: 'mysql-01', dependency_type: 'service_database' },
    ];

    const recentEvents = [
      { id: 'ev-1', title: 'Disk full mysql-01', host_name: 'mysql-01', check_type: 'disk', severity: 'critical', timestamp: new Date(Date.now() - 10000).toISOString() },
    ];

    const result = analyzeRootCause(incident, { topology, recent_events: recentEvents, similar_incidents: [] });

    assert.ok(result.root_cause_hypotheses.length > 0);
    const sorted = [...result.root_cause_hypotheses].sort((a, b) => b.confidence - a.confidence);
    assert.equal(result.root_cause_hypotheses[0].confidence, sorted[0].confidence);
  });
});

// ─── Event Correlation ───────────────────────────────────────────────────────

const { deduplicateAlerts, clusterEvents, detectPatterns } = require('../src/correlation-engine');

describe('Event Correlation Engine', () => {
  it('deve deduplicar alertas idênticos na mesma janela', () => {
    const now = new Date();
    const alerts = [
      { id: 'a1', host_name: 'server-01', check_type: 'disk', severity: 'warning', timestamp: now.toISOString() },
      { id: 'a2', host_name: 'server-01', check_type: 'disk', severity: 'warning', timestamp: new Date(now.getTime() + 30000).toISOString() },
      { id: 'a3', host_name: 'server-02', check_type: 'disk', severity: 'warning', timestamp: new Date(now.getTime() + 40000).toISOString() },
    ];

    const result = deduplicateAlerts(alerts, 300000);
    assert.equal(result.total, 3);
    assert.equal(result.dedup_count, 1);
    assert.equal(result.unique_count, 2);
  });

  it('deve agrupar eventos por host e tipo', () => {
    const now = new Date();
    const events = [
      { id: 'e1', host_name: 'server-01', check_type: 'disk', severity: 'warning', timestamp: now.toISOString() },
      { id: 'e2', host_name: 'server-01', check_type: 'load', severity: 'critical', timestamp: new Date(now.getTime() + 30000).toISOString() },
      { id: 'e3', host_name: 'server-02', check_type: 'disk', severity: 'warning', timestamp: new Date(now.getTime() + 3600000).toISOString() },
    ];

    const clusters = clusterEvents(events, { windowMs: 600000 });
    assert.ok(clusters.length >= 1);
    assert.ok(clusters[0].size >= 1);
  });

  it('deve detectar padrão de flapping', () => {
    const now = new Date();
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        id: `flap-${i}`,
        host_name: 'server-01',
        check_type: 'hostalive',
        severity: i % 2 === 0 ? 'critical' : 'ok',
        status: i % 2 === 0 ? 'down' : 'up',
        timestamp: new Date(now.getTime() + i * 60000).toISOString(),
      });
    }

    const patterns = detectPatterns(events);
    const flapping = patterns.filter(p => p.type === 'flapping');
    assert.ok(flapping.length > 0);
    assert.ok(flapping[0].host === 'server-01');
  });
});

// ─── Incident Memory ─────────────────────────────────────────────────────────

const { IncidentStore, findSimilarIncidents } = require('../src/incident-memory');

describe('Incident Memory', () => {
  it('deve armazenar e recuperar incidentes', () => {
    const store = new IncidentStore();
    store.add({ id: 'i1', title: 'MySQL down', severity: 'critical', check_type: 'tcp' });
    store.add({ id: 'i2', title: 'PostgreSQL slow', severity: 'warning', check_type: 'tcp' });

    const stats = store.getStats();
    assert.equal(stats.total, 2);
  });

  it('deve encontrar incidentes similares', () => {
    const store = new IncidentStore();
    store.add({ id: 'i1', title: 'MySQL production down', severity: 'critical', check_type: 'tcp', host_name: 'mysql-01', target_type: 'database', status: 'open' });
    store.add({ id: 'i2', title: 'PostgreSQL slow queries', severity: 'warning', check_type: 'tcp', host_name: 'postgres-01', target_type: 'database', status: 'open' });
    store.add({ id: 'i3', title: 'Nginx high latency', severity: 'warning', check_type: 'http', host_name: 'nginx-01', target_type: 'web', status: 'open' });

    const similar = store.search({ title: 'MySQL critical down', severity: 'critical', check_type: 'tcp', host_name: 'mysql-01', target_type: 'database' }, { minSimilarity: 0.2 });
    assert.ok(similar.length >= 1);
    assert.equal(similar[0].id, 'i1');
  });

  it('deve retornar stats por severidade', () => {
    const store = new IncidentStore();
    store.add({ id: 'i1', title: 'A', severity: 'critical', status: 'open' });
    store.add({ id: 'i2', title: 'B', severity: 'critical', status: 'open' });
    store.add({ id: 'i3', title: 'C', severity: 'warning', status: 'resolved' });

    const stats = store.getStats();
    assert.equal(stats.by_severity.critical, 2);
    assert.equal(stats.by_severity.warning, 1);
    assert.equal(stats.by_status.open, 2);
    assert.equal(stats.by_status.resolved, 1);
  });
});

// ─── Knowledge Base ──────────────────────────────────────────────────────────

const { findPlaybooks, FeedbackLoop } = require('../src/knowledge-base');

describe('Knowledge Base', () => {
  it('deve encontrar playbooks para disco cheio', () => {
    const incident = { check_type: 'disk', severity: 'critical', target_type: 'server' };
    const results = findPlaybooks(incident);

    assert.ok(results.length > 0);
    assert.ok(results[0].playbook.id.includes('disk'));
    assert.ok(results[0].relevance > 0);
  });

  it('deve retornar playbook para certificado expirando', () => {
    const incident = { check_type: 'ssl_cert', severity: 'warning' };
    const results = findPlaybooks(incident);

    assert.ok(results.some(r => r.playbook.id === 'pb_cert_expiring'));
  });

  it('FeedbackLoop deve calcular taxa de sucesso', () => {
    const loop = new FeedbackLoop();
    loop.record('inc-1', 'pb_disk_full', 1);
    loop.record('inc-2', 'pb_disk_full', 1);
    loop.record('inc-3', 'pb_disk_full', -1);
    loop.record('inc-4', 'pb_service_down', 1);

    const stats = loop.getStats();
    assert.equal(stats.overall.total, 4);
    assert.equal(stats.overall.positive, 3);
    assert.equal(stats.overall.negative, 1);
    assert.equal(stats.success_rate, 0.75);
  });

  it('FeedbackLoop deve calcular efetividade por remediação', () => {
    const loop = new FeedbackLoop();
    loop.record('inc-1', 'pb_disk_full', 1);
    loop.record('inc-2', 'pb_disk_full', 1);
    loop.record('inc-3', 'pb_disk_full', -1);

    const effectiveness = loop.getEffectiveness('pb_disk_full');
    assert.equal(effectiveness.total, 3);
    assert.equal(effectiveness.positive, 2);
    assert.equal(effectiveness.success_rate, 2 / 3);
  });
});

// ─── Run ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // Tests are run via node --test
}
