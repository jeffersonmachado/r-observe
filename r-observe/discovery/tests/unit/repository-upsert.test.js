'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { upsertAsset } = require('../../src/engine/repository');

test('upsertAsset faz merge por identidade lógica quando asset_key muda', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes('WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND asset_key = $4')) {
        return { rows: [] };
      }

      if (sql.includes('lifecycle_state <> \'disappeared\'')) {
        return {
          rows: [{
            id: 'asset-existing-id',
            asset_key: 'docker:old-container-id',
            asset_name: 'r-observe-api',
            primary_ip: '172.20.0.5',
            vendor: 'infra-r-observe-api',
            product: 'infra-r-observe-api',
            os_hint: null,
            hostname: 'r-observe-api',
            confidence: 0.8,
          }],
        };
      }

      if (sql.startsWith('UPDATE observe_assets')) {
        return {
          rows: [{
            id: 'asset-existing-id',
            tenant_id: 'default',
            site_id: 'default-site',
            edge_id: 'central',
            asset_key: 'docker:old-container-id',
            asset_name: params[1],
            display_name: params[2],
            asset_type: params[3],
            vendor: params[4],
            product: params[5],
            os_hint: params[6],
            primary_ip: params[7],
            hostname: params[8],
            lifecycle_state: params[9],
            criticality: params[10],
            confidence: params[11],
            metadata: JSON.parse(params[12]),
          }],
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const asset = await upsertAsset(db, {
    tenant_id: 'default',
    site_id: 'default-site',
    edge_id: 'central',
    asset_key: 'docker:new-container-id',
    asset_name: 'r-observe-api',
    display_name: 'r-observe-api',
    asset_type: 'host',
    vendor: 'Não identificado',
    product: 'Sem sinal de serviço',
    primary_ip: '172.20.0.5',
    hostname: 'r-observe-api',
    lifecycle_state: 'discovered',
    criticality: 'medium',
    confidence: 0.5,
    metadata: {},
  });

  assert.strictEqual(asset.id, 'asset-existing-id');
  assert.strictEqual(asset.asset_key, 'docker:old-container-id');

  const updateCall = calls.find((entry) => entry.sql.startsWith('UPDATE observe_assets'));
  assert.ok(updateCall, 'expected logical merge via UPDATE observe_assets');

  const insertCall = calls.find((entry) => entry.sql.startsWith('INSERT INTO observe_assets'));
  assert.strictEqual(insertCall, undefined);
});
