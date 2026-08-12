'use strict';

const { createDbClient } = require('./db');
const { runMigrations } = require('./migrate');
const { ensureExporterDbRole, ensureRuntimeDbRole } = require('./runtime-db-role');

async function bootstrapDatabase(env = process.env) {
  const adminDb = createDbClient({
    ...env,
    DB_USER: env.DB_ADMIN_USER,
    DB_PASSWORD: env.DB_ADMIN_PASSWORD,
  });
  try {
    await runMigrations(adminDb);
    const runtimeRole = await ensureRuntimeDbRole(adminDb, env);
    const exporterRole = await ensureExporterDbRole(adminDb, env);
    return { runtimeRole, exporterRole };
  } finally {
    await adminDb.end();
  }
}

if (require.main === module) {
  bootstrapDatabase()
    .then((roles) => process.stdout.write(JSON.stringify({ level: 'info', service: 'r-observe-db-bootstrap', msg: 'Database ready', ...roles }) + '\n'))
    .catch((error) => {
      process.stderr.write(JSON.stringify({ level: 'error', service: 'r-observe-db-bootstrap', msg: 'Database bootstrap failed', error: error.message }) + '\n');
      process.exit(1);
    });
}

module.exports = { bootstrapDatabase };
