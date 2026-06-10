'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { bootstrapInitialUsers, parseInitialUsers } = require('../src/bootstrap');

test('parseInitialUsers includes configured IcingaWeb admin first', () => {
  const users = parseInitialUsers({
    ICINGAWEB_ADMIN_USER: 'admin',
    ICINGAWEB_ADMIN_PASS: 'secret',
    OBSERVE_INITIAL_USERS_JSON: JSON.stringify([{ name: 'ops', password: 'ops-secret', admin: false }]),
  });

  assert.deepEqual(users.map((user) => user.name), ['admin', 'ops']);
  assert.equal(users[0].admin, true);
  assert.equal(users[1].admin, false);
});

test('bootstrapInitialUsers is idempotent by default and never logs passwords', async () => {
  const queries = [];
  const logs = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      // Simula: grupo existe, usuário não existe, membership não existe
      if (sql.includes('SELECT id FROM icingaweb_group')) return { rowCount: 1, rows: [{ id: 1 }] };
      if (sql.includes('SELECT 1 FROM icingaweb_user')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT 1 FROM icingaweb_group_membership')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };

  const result = await bootstrapInitialUsers(pool, {
    ICINGAWEB_ADMIN_USER: 'admin',
    ICINGAWEB_ADMIN_PASS: 'secret',
  }, { log: (line) => logs.push(line) });

  assert.equal(result.users, 1);
  // Espera: INSERT grupo + SELECT grupo id + SELECT user existe + INSERT user + SELECT membership + INSERT membership
  assert.ok(queries.length >= 3, `esperado >= 3 queries, recebeu ${queries.length}`);
  // Valida que a senha nunca aparece nos logs
  assert.doesNotMatch(logs.join('\n'), /secret/);
});

test('bootstrapInitialUsers can force password updates explicitly', async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      // Simula: grupo existe, usuário já existe (force update)
      if (sql.includes('SELECT id FROM icingaweb_group')) return { rowCount: 1, rows: [{ id: 1 }] };
      if (sql.includes('SELECT 1 FROM icingaweb_user')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT 1 FROM icingaweb_group_membership')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };

  await bootstrapInitialUsers(pool, {
    ICINGAWEB_ADMIN_USER: 'admin',
    ICINGAWEB_ADMIN_PASS: 'secret',
    OBSERVE_BOOTSTRAP_FORCE_PASSWORD_UPDATE: 'true',
  }, { log: () => {} });

  // Com force, deve usar UPDATE em vez de INSERT para usuário existente
  const updateQuery = queries.find(q => q.sql.includes('UPDATE icingaweb_user'));
  assert.ok(updateQuery, 'deve ter UPDATE icingaweb_user com forcePasswordUpdate');
});
