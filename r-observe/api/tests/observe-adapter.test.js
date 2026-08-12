'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { sessionHash } = require('@results/auth');
const { ObserveAdapter, isCurrentPasswordHash } = require('../src/auth/observe-adapter');

it('ObserveAdapter nunca persiste nem consulta o token de sessão bruto', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT username')) {
        return {
          rowCount: 1,
          rows: [{
            username: 'ops', role: 'operator', tenantId: 'tenant-a',
            csrfToken: 'csrf', expiresAt: new Date(Date.now() + 60_000),
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const adapter = new ObserveAdapter(db);
  const token = 'raw-secret-token';
  await adapter.createSession({
    token, csrfToken: 'csrf', username: 'ops', userSnapshot: { role: 'operator', tenantId: 'tenant-a' },
    expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), lastActivityAt: new Date(),
  });
  const found = await adapter.findSession(token);
  await adapter.destroySession(token);

  assert.equal(calls[0].params[0], sessionHash(token));
  assert.equal(calls[1].params[0], sessionHash(token));
  assert.equal(calls[2].params[0], sessionHash(token));
  assert.equal(calls.some(({ params }) => params.includes(token)), false);
  assert.equal(found.userSnapshot.tenantId, 'tenant-a');
  assert.equal(found.csrfToken, 'csrf');
});

it('aplica bcrypt cost 12 também para usuário inexistente', async () => {
  let call;
  const adapter = new ObserveAdapter({
    async query(sql, params) { call = { sql, params }; return { rowCount: 1, rows: [] }; },
  });
  await adapter.consumePasswordCost('candidate');
  assert.match(call.sql, /gen_salt\('bf', 12\)/);
  assert.deepEqual(call.params, ['candidate']);
});

it('aceita somente o formato bcrypt definitivo com cost 12', async () => {
  assert.equal(isCurrentPasswordHash('$2a$12$restante'), true);
  assert.equal(isCurrentPasswordHash(Buffer.from('$2y$12$restante')), true);
  assert.equal(isCurrentPasswordHash('$2a$06$legado'), false);
  assert.equal(isCurrentPasswordHash('invalido'), false);

  let sql;
  const adapter = new ObserveAdapter({
    async query(query) { sql = query; return { rowCount: 1, rows: [] }; },
  });
  assert.equal(await adapter.verifyPassword({ username: 'ops', _passwordHash: '$2a$06$legado' }, 'candidate'), false);
  assert.match(sql, /gen_salt\('bf', 12\)/);
});
