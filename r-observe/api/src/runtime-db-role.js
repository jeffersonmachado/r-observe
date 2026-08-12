'use strict';

const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

async function ensureRuntimeDbRole(adminDb, env = process.env) {
  const role = String(env.DB_USER || 'observe_app');
  const password = String(env.DB_PASSWORD || '');
  if (!ROLE_PATTERN.test(role)) throw new Error('DB_USER inválido para role runtime');
  if (!password) throw new Error('DB_PASSWORD obrigatório para role runtime');

  const formatted = await adminDb.query(
    `SELECT
       format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', $1::text) AS create_sql,
       format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS alter_sql,
       format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS database_grant_sql,
       format('GRANT USAGE ON SCHEMA public TO %I', $1::text) AS schema_grant_sql,
       format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', $1::text) AS table_grant_sql,
       format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', $1::text) AS sequence_grant_sql,
       format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', $1::text) AS function_grant_sql,
       format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', $1::text) AS default_table_grant_sql,
       format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', $1::text) AS default_sequence_grant_sql,
       format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', $1::text) AS default_function_grant_sql`,
    [role, password]
  );
  const sql = formatted.rows[0];
  const exists = await adminDb.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!exists.rowCount) await adminDb.query(sql.create_sql);
  for (const key of Object.keys(sql).filter((name) => name !== 'create_sql')) {
    await adminDb.query(sql[key]);
  }
  return role;
}

async function ensureExporterDbRole(adminDb, env = process.env) {
  const role = String(env.DB_EXPORTER_USER || 'observe_exporter');
  const password = String(env.DB_EXPORTER_PASSWORD || '');
  if (!ROLE_PATTERN.test(role)) throw new Error('DB_EXPORTER_USER inválido');
  if (!password) throw new Error('DB_EXPORTER_PASSWORD obrigatório');

  const formatted = await adminDb.query(
    `SELECT
       format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS', $1::text) AS create_sql,
       format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS alter_sql,
       format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS database_grant_sql,
       format('GRANT pg_monitor TO %I WITH INHERIT TRUE', $1::text) AS monitor_grant_sql`,
    [role, password]
  );
  const sql = formatted.rows[0];
  const exists = await adminDb.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (!exists.rowCount) await adminDb.query(sql.create_sql);
  await adminDb.query(sql.alter_sql);
  await adminDb.query(sql.database_grant_sql);
  await adminDb.query(sql.monitor_grant_sql);
  return role;
}

module.exports = { ensureExporterDbRole, ensureRuntimeDbRole, ROLE_PATTERN };
