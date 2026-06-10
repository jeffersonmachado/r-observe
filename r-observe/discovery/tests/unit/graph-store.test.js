'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { enabled, shortestPath, blastRadius, dependencyTraversal } = require('../../src/topology/graph-store');

test('graph-store enabled depende de env', () => {
  const prevUri = process.env.NEO4J_URI;
  const prevPwd = process.env.NEO4J_PASSWORD;

  delete process.env.NEO4J_URI;
  delete process.env.NEO4J_PASSWORD;
  delete require.cache[require.resolve('../../src/topology/graph-store')];
  const mod1 = require('../../src/topology/graph-store');
  assert.strictEqual(mod1.enabled(), false);

  process.env.NEO4J_URI = 'bolt://neo4j:7687';
  process.env.NEO4J_PASSWORD = 'secret';
  delete require.cache[require.resolve('../../src/topology/graph-store')];
  const mod2 = require('../../src/topology/graph-store');
  assert.strictEqual(mod2.enabled(), true);

  if (prevUri === undefined) delete process.env.NEO4J_URI;
  else process.env.NEO4J_URI = prevUri;
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

test('graph-store degrada graciosamente sem neo4j habilitado', async () => {
  const tenant = { tenant_id: 't', site_id: 's', edge_id: 'e' };
  const p = await shortestPath({ tenant, fromAssetKey: 'a', toAssetRef: 'b' });
  const b = await blastRadius({ tenant, assetKey: 'a' });
  const d = await dependencyTraversal({ tenant, assetKey: 'a' });

  assert.strictEqual(typeof enabled(), 'boolean');
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(b.enabled, false);
  assert.strictEqual(d.enabled, false);
});
