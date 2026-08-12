'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toPgLikeResult } = require('../../src/shared/sequelize-db');

test('adaptador preserva metadata.rowCount em UPDATE sem RETURNING', () => {
  assert.deepEqual(toPgLikeResult([], { rowCount: 1 }), { rows: [], rowCount: 1 });
});

test('adaptador usa o tamanho das rows em SELECT sem metadata rowCount', () => {
  const rows = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(toPgLikeResult(rows, {}), { rows, rowCount: 2 });
});
