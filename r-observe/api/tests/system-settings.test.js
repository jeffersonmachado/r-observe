'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createSystemSettingsService, mergeSettings } = require('../src/services/system-settings');

const defaults = {
  discovery: { scan_interval_minutes: 60, arp_enabled: true },
  agents: { disk_warn_percent: 80 },
  certs: { expiry_warning_days: 30, expiry_critical_days: 7 },
  os_defaults: { linux_node_exporter: true },
  ai: { provider: 'mock', model: 'auto', auto_threshold: 0.85, max_auto_severity: 'warning' },
  monitoring: { icinga_sync_enabled: true },
};

describe('System settings persistence', () => {
  it('mescla apenas campos conhecidos e preserva os padrões', () => {
    const merged = mergeSettings(defaults, {
      discovery: { scan_interval_minutes: 15, unknown: 'ignored' },
      agents: { disk_warn_percent: 'invalid' },
      injected: { enabled: true },
    });
    assert.equal(merged.discovery.scan_interval_minutes, 15);
    assert.equal(merged.discovery.arp_enabled, true);
    assert.equal(merged.agents.disk_warn_percent, 80);
    assert.equal('unknown' in merged.discovery, false);
    assert.equal('injected' in merged, false);
  });

  it('grava antes de publicar o novo estado em memória', async () => {
    let persisted = { discovery: { scan_interval_minutes: 20 } };
    const db = {
      async query(sql, params) {
        if (sql.startsWith('SELECT')) return { rows: [{ settings: persisted }] };
        persisted = JSON.parse(params[0]);
        return { rows: [], rowCount: 1 };
      },
    };
    const service = createSystemSettingsService({ db, defaults });
    assert.equal((await service.load()).discovery.scan_interval_minutes, 20);
    assert.equal((await service.update({ discovery: { arp_enabled: false } })).discovery.arp_enabled, false);

    const restarted = createSystemSettingsService({ db, defaults });
    const afterRestart = await restarted.load();
    assert.equal(afterRestart.discovery.scan_interval_minutes, 20);
    assert.equal(afterRestart.discovery.arp_enabled, false);
  });
});
