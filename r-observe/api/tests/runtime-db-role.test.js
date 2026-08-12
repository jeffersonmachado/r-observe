'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ensureExporterDbRole, ensureRuntimeDbRole } = require('../src/runtime-db-role');

describe('PostgreSQL runtime role', () => {
  it('provisions a login role without RLS bypass privileges', async () => {
    const executed = [];
    const statements = {
      create_sql: 'CREATE ROLE observe_app LOGIN NOSUPERUSER NOBYPASSRLS',
      alter_sql: 'ALTER ROLE observe_app NOSUPERUSER NOBYPASSRLS',
      database_grant_sql: 'GRANT CONNECT',
      schema_grant_sql: 'GRANT USAGE',
      table_grant_sql: 'GRANT TABLES',
      sequence_grant_sql: 'GRANT SEQUENCES',
      function_grant_sql: 'GRANT FUNCTIONS',
      default_table_grant_sql: 'ALTER DEFAULT TABLES',
      default_sequence_grant_sql: 'ALTER DEFAULT SEQUENCES',
      default_function_grant_sql: 'ALTER DEFAULT FUNCTIONS',
    };
    const db = {
      async query(sql) {
        executed.push(sql);
        if (sql.startsWith('SELECT\n')) return { rows: [statements], rowCount: 1 };
        if (sql.startsWith('SELECT 1 FROM pg_roles')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
    };

    await ensureRuntimeDbRole(db, { DB_USER: 'observe_app', DB_PASSWORD: 'runtime-secret' });
    assert.ok(executed.includes(statements.create_sql));
    assert.ok(executed.includes(statements.alter_sql));
    assert.match(statements.alter_sql, /NOSUPERUSER.*NOBYPASSRLS/);
  });

  it('rejects unsafe role identifiers', async () => {
    await assert.rejects(
      ensureRuntimeDbRole({}, { DB_USER: 'observe_app; DROP ROLE observe', DB_PASSWORD: 'x' }),
      /DB_USER inválido/
    );
  });

  it('provisions a dedicated metrics role with pg_monitor only', async () => {
    const executed = [];
    const statements = {
      create_sql: 'CREATE ROLE observe_exporter LOGIN NOSUPERUSER NOBYPASSRLS',
      alter_sql: 'ALTER ROLE observe_exporter NOSUPERUSER NOBYPASSRLS',
      database_grant_sql: 'GRANT CONNECT',
      monitor_grant_sql: 'GRANT pg_monitor TO observe_exporter WITH INHERIT TRUE',
    };
    const db = {
      async query(sql) {
        executed.push(sql);
        if (sql.startsWith('SELECT\n')) return { rows: [statements], rowCount: 1 };
        if (sql.startsWith('SELECT 1 FROM pg_roles')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
    };

    await ensureExporterDbRole(db, {
      DB_EXPORTER_USER: 'observe_exporter',
      DB_EXPORTER_PASSWORD: 'metrics-secret',
    });
    assert.match(executed[0], /NOCREATEROLE INHERIT NOBYPASSRLS/);
    assert.ok(executed.includes(statements.monitor_grant_sql));
    assert.ok(!executed.some((sql) => /GRANT (?:SELECT|INSERT|UPDATE|DELETE) ON ALL TABLES/.test(sql)));
  });
});
