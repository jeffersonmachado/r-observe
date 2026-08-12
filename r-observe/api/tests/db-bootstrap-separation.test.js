'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');

it('keeps administrative database credentials out of the long-running API service', () => {
  const compose = fs.readFileSync(path.resolve(__dirname, '../../../docker-compose.observe.yml'), 'utf8');
  const apiBlock = compose.split('  r-observe-api:')[1].split('\n  r-observe-worker:')[0];
  const bootstrapBlock = compose.split('  r-observe-db-bootstrap:')[1].split('\n  # ─── R-OBSERVE API')[0];

  assert.doesNotMatch(apiBlock, /DB_ADMIN_(?:USER|PASSWORD):/);
  assert.match(apiBlock, /service_completed_successfully/);
  assert.match(bootstrapBlock, /DB_ADMIN_USER:/);
  assert.match(bootstrapBlock, /src\/db-bootstrap\.js/);
});

it('keeps the PostgreSQL superuser out of IcingaWeb runtime', () => {
  const compose = fs.readFileSync(path.resolve(__dirname, '../../../docker-compose.observe.yml'), 'utf8');
  const icingaWebBlock = compose.split('  r-observe-icingaweb2:')[1].split('\n  r-observe-prometheus:')[0];

  assert.match(icingaWebBlock, /icingaweb\.resources\.icingaweb2\.username: \$\{OBSERVE_DB_APP_USER/);
  assert.doesNotMatch(icingaWebBlock, /icingaweb\.resources\.icingaweb2\.username: \$\{OBSERVE_DB_USER/);
  assert.match(icingaWebBlock, /service_completed_successfully/);
});
