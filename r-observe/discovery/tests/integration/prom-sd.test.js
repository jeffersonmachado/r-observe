'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toPromSdGroups } = require('../../src/exporters/prometheus-sd');

test('converte assets para grupos SD', () => {
  const groups = toPromSdGroups([
    {
      tenant_id: 't1',
      site_id: 's1',
      edge_id: 'e1',
      asset_name: 'node-a',
      services: [{ exporter_target: '10.0.0.10:9100', job: 'node-exporter' }],
    },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].targets[0], '10.0.0.10:9100');
  assert.equal(groups[0].labels.job, 'node-exporter');
});
