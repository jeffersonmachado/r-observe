'use strict';

// Chaves RS256 de teste precisam estar no ambiente antes do require do jwt.js,
// pois o event-processor assina tokens internos com a chave privada.
const crypto = require('crypto');
{
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY = publicKey;
}

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');
const { createEventProcessor } = require('./event-processor');

function mockLog() {
  return () => {};
}

function mockDb() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql: sql.slice(0, 80), params });
      // upsertHost: retorna id e inserted
      if (sql.includes('INSERT INTO observe_hosts') && sql.includes('ON CONFLICT')) {
        return { rows: [{ id: 'host-uuid-1', inserted: true }], rowCount: 1 };
      }
      // Resolve/close incidents
      if (sql.includes('UPDATE observe_incidents') && sql.includes('resolved')) {
        return { rows: [{ id: 'inc-1' }], rowCount: 1 };
      }
      // Create incident
      if (sql.includes('INSERT INTO observe_incidents') && sql.includes('VALUES')) {
        return { rows: [{ id: 'inc-new' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function mockRemediation() {
  return {
    isActionAllowed: () => true,
    canAutoExecute: () => true,
    executeAction: async () => ({ success: true, output: 'ok' }),
    setCatalogMeta: () => {},
    AUTO_THRESHOLD: 0.85,
    MAX_AUTO_SEVERITY: 'warning',
  };
}

function mockIcinga() {
  return {
    registerHost: async () => ({ ok: true, existed: false }),
    rescheduleCheck: async () => ({ ok: true }),
  };
}

const baseConfig = {
  AI_ENABLED: false,
  AI_SERVICE_URL: 'http://ai:3000',
  REMEDIATION_ENABLED: false,
  PROACTIVE_STALE_MIN: 10,
};

describe('Event Processor', () => {
  let db, processor;

  beforeEach(() => {
    db = mockDb();
    processor = createEventProcessor({
      db,
      remediation: mockRemediation(),
      icinga: mockIcinga(),
      log: mockLog(),
      config: baseConfig,
    });
  });

  it('processEvent ignora JSON invalido', async () => {
    const result = await processor.processEvent('not-json');
    assert.equal(result, undefined);
  });

  it('processEvent ignora tipo de evento nao-trigger', async () => {
    await processor.processEvent(JSON.stringify({ type: 'ping', source: 'test' }));
    // Nao deve criar incidente
    const inserts = db.queries.filter(q => q.sql.includes('INSERT INTO observe_incidents'));
    assert.equal(inserts.length, 0);
  });

  it('processEvent cria incidente para host.down', async () => {
    await processor.processEvent(JSON.stringify({
      type: 'host.down',
      source: 'icinga',
      host: 'test-host',
      address: '10.0.0.1',
      id: 'evt-001',
      severity: 'critical',
    }));

    const inserts = db.queries.filter(q => q.sql.includes('INSERT INTO observe_incidents'));
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params[2], 'critical');
    assert.match(inserts[0].params[1], /HOST\.DOWN/);
  });

  it('processEvent cria incidente para container.stopped', async () => {
    await processor.processEvent(JSON.stringify({
      type: 'container.stopped',
      source: 'agent',
      host: 'docker-host',
      service: 'nginx',
      severity: 'warning',
    }));

    const inserts = db.queries.filter(q => q.sql.includes('INSERT INTO observe_incidents'));
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params[2], 'warning');
  });

  it('processEvent resolve incidentes com host.recovery', async () => {
    await processor.processEvent(JSON.stringify({
      type: 'host.recovery',
      source: 'icinga',
      host: 'recovered-host',
      address: '10.0.0.2',
    }));

    const updates = db.queries.filter(q =>
      q.sql.includes('UPDATE observe_incidents') && q.sql.includes('resolved')
    );
    assert.equal(updates.length, 1);
  });

  it('check.recovery resolve somente o incidente do alvo recuperado', async () => {
    await processor.processEvent(JSON.stringify({
      type: 'check.recovery',
      source: 'agent',
      host: 'agent-01',
      target: 'grafana',
    }));

    const update = db.queries.find(q =>
      q.sql.includes('UPDATE observe_incidents') && q.sql.includes('resolved')
    );
    assert.deepEqual(update.params, ['host-uuid-1', '[CHECK.FAILED] agent-01 / grafana']);
  });

  it('processEvent nao duplica incidente para mesmo host+tipo', async () => {
    // Mock para simular incidente existente
    const dbWithExisting = {
      queries: [],
      async query(sql, params = []) {
        this.queries.push({ sql, params });
        if (sql.includes('INSERT INTO observe_hosts') && sql.includes('ON CONFLICT')) {
          return { rows: [{ id: 'host-uuid-dup', inserted: true }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM observe_incidents')) {
          return { rows: [{ id: 'existing-id' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const proc = createEventProcessor({
      db: dbWithExisting,
      remediation: mockRemediation(),
      icinga: mockIcinga(),
      log: mockLog(),
      config: baseConfig,
    });

    await proc.processEvent(JSON.stringify({
      type: 'host.down',
      source: 'icinga',
      host: 'dup-host',
      id: 'evt-001',
    }));

    const inserts = dbWithExisting.queries.filter(q => q.sql.includes('INSERT INTO observe_incidents'));
    assert.equal(inserts.length, 0);
    const recurrenceUpdates = dbWithExisting.queries.filter(q =>
      q.sql.includes('UPDATE observe_incidents') && q.sql.includes('repeat_count')
    );
    assert.equal(recurrenceUpdates.length, 1);
  });

  it('inclui o alvo do check na identidade semântica do incidente', async () => {
    await processor.processEvent(JSON.stringify({
      type: 'check.failed',
      source: 'agent',
      host: 'agent-01',
      target: 'grafana',
      id: 'evt-check-1',
    }));

    const inserts = db.queries.filter(q => q.sql.includes('INSERT INTO observe_incidents'));
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params[1], '[CHECK.FAILED] agent-01 / grafana');
  });

  it('processScanResults ignora payload invalido', async () => {
    await processor.processScanResults('not-json');
    assert.equal(db.queries.length, 0);
  });

  it('processScanResults upserta hosts do scan', async () => {
    const localDb = mockDb();
    const localProcessor = createEventProcessor({
      db: localDb,
      remediation: mockRemediation(),
      icinga: mockIcinga(),
      log: mockLog(),
      config: baseConfig,
    });

    await localProcessor.processScanResults(JSON.stringify({
      hosts: [
        { name: 'host-a', address: '10.0.0.1', ports: [22, 80] },
        { name: 'host-b', address: '10.0.0.2' },
      ],
    }));

    const upserts = localDb.queries.filter(q =>
      q.sql.includes('INSERT INTO observe_hosts')
    );
    assert.equal(upserts.length, 2);
    assert.equal(upserts[0].params[1], 'host-a');
    assert.equal(upserts[1].params[1], 'host-b');
  });

  it('processScanResults ignora hosts sem nome ou address', async () => {
    await processor.processScanResults(JSON.stringify({
      hosts: [
        { name: '', address: '10.0.0.1' },
        { name: 'host-b' },
      ],
    }));

    const upserts = db.queries.filter(q =>
      q.sql.includes('INSERT INTO observe_hosts') && q.sql.includes('ON CONFLICT')
    );
    assert.equal(upserts.length, 0);
  });

  it('proactiveAnalysis nao faz nada com AI desabilitado', async () => {
    const ref = { count: 0 };
    await processor.proactiveAnalysis(ref);
    // Nao deve fazer queries (AI_ENABLED=false)
    const analysisQueries = db.queries.filter(q =>
      q.sql.includes('ai_summary IS NULL')
    );
    assert.equal(analysisQueries.length, 0);
  });

  it('dispatchApprovedRemediation ignora JSON invalido', async () => {
    await processor.dispatchApprovedRemediation('not-json');
    // Nao deve crashar
  });
});
