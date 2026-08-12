'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('migration 020 scopes IPAM addresses by tenant and site', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../migrations/020_discovery_tenant_hardening.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS tenant_id/);
  assert.match(sql, /tenant_id, site_id, ip/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS observe_ipam_ips_ip_key/);
});
