'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createDbClient } = require('../src/db');
const { runWithTenant } = require('../src/shared/tenant-context');

function fakeSequelize() {
  const calls = [];
  const transaction = {
    async commit() { calls.push({ sql: 'COMMIT' }); },
    async rollback() { calls.push({ sql: 'ROLLBACK' }); },
  };
  return {
    calls,
    activeTransaction: transaction,
    async query(sql, options = {}) {
      calls.push({ sql, options });
      return [[{ ok: true }], { rowCount: 1 }];
    },
    async transaction(callback) {
      calls.push({ sql: 'BEGIN' });
      if (callback) return callback(transaction);
      return transaction;
    },
    async close() { calls.push({ sql: 'CLOSE' }); },
  };
}

describe('Sequelize DB client padronizado', () => {
  it('executa consulta default sem transação implícita', async () => {
    const sequelize = fakeSequelize();
    const db = createDbClient({}, sequelize);
    const result = await db.query('SELECT $1::int AS value', [7]);
    assert.equal(result.rowCount, 1);
    assert.equal(sequelize.calls[0].sql, 'SELECT $1::int AS value');
    assert.deepEqual(sequelize.calls[0].options.bind, [7]);
  });

  it('não ativa o parser de bind em blocos PostgreSQL sem parâmetros', async () => {
    const sequelize = fakeSequelize();
    const db = createDbClient({}, sequelize);
    const sql = 'DO $$ BEGIN PERFORM 1; END $$;';
    await db.query(sql);
    assert.equal(sequelize.calls[0].sql, sql);
    assert.equal(Object.hasOwn(sequelize.calls[0].options, 'bind'), false);
  });

  it('isola consulta tenant em transação com SET LOCAL', async () => {
    const sequelize = fakeSequelize();
    const db = createDbClient({}, sequelize);
    await runWithTenant('tenant-a', () => db.query('SELECT * FROM observe_assets'));
    assert.deepEqual(sequelize.calls.map((call) => call.sql), [
      'BEGIN', "SELECT set_config('app.tenant_id', $1, true)", 'SELECT * FROM observe_assets',
    ]);
    assert.deepEqual(sequelize.calls[1].options.bind, ['tenant-a']);
    assert.equal(sequelize.calls[2].options.transaction, sequelize.activeTransaction);
  });

  it('aplica tenant ao BEGIN explícito e conclui COMMIT', async () => {
    const sequelize = fakeSequelize();
    const db = createDbClient({}, sequelize);
    await runWithTenant('tenant-b', async () => {
      const client = await db.connect();
      await client.query('BEGIN');
      await client.query('UPDATE observe_assets SET hostname = $1', ['host']);
      await client.query('COMMIT');
      client.release();
    });
    assert.deepEqual(sequelize.calls.map((call) => call.sql), [
      'BEGIN', "SELECT set_config('app.tenant_id', $1, true)",
      'UPDATE observe_assets SET hostname = $1', 'COMMIT',
    ]);
    assert.equal(sequelize.calls[2].options.transaction, sequelize.activeTransaction);
  });
});
