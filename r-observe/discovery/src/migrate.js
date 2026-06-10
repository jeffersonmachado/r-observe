'use strict';

const { Umzug } = require('umzug');
const path      = require('path');
const fs        = require('fs');

// Fluxo e contrato de migrations: docs/observe/migrations.md

// ─── Custom storage: grava estado via Sequelize ────────────────────────────
class MigrationStorage {
  constructor(db, table = 'schema_migrations') {
    this.db    = db;
    this.table = table;
  }

  async _ensureTable() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        name       TEXT        PRIMARY KEY,
        run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async logMigration({ name }) {
    await this._ensureTable();
    await this.db.query(`INSERT INTO ${this.table} (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
  }

  async unlogMigration({ name }) {
    await this._ensureTable();
    await this.db.query(`DELETE FROM ${this.table} WHERE name = $1`, [name]);
  }

  async executed() {
    await this._ensureTable();
    const r = await this.db.query(`SELECT name FROM ${this.table} ORDER BY name`);
    return r.rows.map(row => row.name);
  }
}

// ─── Resolve caminho das migrações ────────────────────────────────────────
function findMigrationsDir() {
  const candidates = [
    path.resolve(__dirname, '../migrations'),         // container: /app/migrations
    path.resolve(__dirname, '../../../migrations'),   // monorepo: r-observe/migrations
    path.resolve(__dirname, '../../migrations'),      // alternativo
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Em container prod, a API ja executou as migrations. Nao e fatal.
  return null;
}

// ─── Executa migrations pendentes ────────────────────────────────────────
async function runMigrations(db) {
  const { log } = require('./utils/logger');
  const migrationsDir = findMigrationsDir();

  if (!migrationsDir) {
    log('info', 'Migration directory not found — API handles migrations');
    return { pending: 0, executed: [], reason: 'dir_not_found' };
  }

  const umzug = new Umzug({
    migrations: {
      glob:    path.join(migrationsDir, '*.sql'),
      resolve: ({ name, path: filePath }) => ({
        name,
        up: async () => {
          const sql = fs.readFileSync(filePath, 'utf8');
          await db.query(sql);
        },
        down: async () => {
          log('warn', 'Down migration not supported', { migration: name });
        },
      }),
    },
    storage:  new MigrationStorage(db),
    logger:   {
      info:  ({ event, name }) => log('info', event, { migration: name }),
      warn:  ({ event, name }) => log('warn', event, { migration: name }),
      error: ({ event, name }) => log('error', event, { migration: name }),
      debug: () => {},
    },
  });

  const pending = await umzug.pending();
  if (pending.length === 0) {
    log('info', 'No pending migrations');
    return { pending: 0, executed: [] };
  }

  log('info', `Running ${pending.length} migration(s)`, { count: pending.length });
  const executed = await umzug.up();
  log('info', 'Migrations completed', { executed: executed.length });
  return { pending: pending.length, executed: executed.map(e => e.name) };
}

module.exports = { runMigrations, MigrationStorage };
