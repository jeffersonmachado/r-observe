'use strict';

const SECTIONS = {
  discovery: {
    scan_interval_minutes: 'number', arp_enabled: 'boolean', docker_enabled: 'boolean',
    cloud_enabled: 'boolean', passive_enabled: 'boolean', port_change_detection: 'boolean',
    port_disappeared_grace_scans: 'number', scan_parallel: 'number', extra_ports: 'string',
  },
  agents: {
    offline_threshold_minutes: 'number', offline_check_enabled: 'boolean',
    check_interval_seconds: 'number', disk_warn_percent: 'number', docker_projects: 'string',
    docker_ignore_containers: 'string',
  },
  certs: { expiry_warning_days: 'number', expiry_critical_days: 'number' },
  os_defaults: { linux_node_exporter: 'boolean', windows_exporter: 'boolean', network_snmp: 'boolean' },
  ai: { provider: 'string', model: 'string', auto_threshold: 'number', max_auto_severity: 'string' },
  monitoring: { icinga_sync_enabled: 'boolean', prometheus_sd_enabled: 'boolean' },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSettings(base, patch) {
  const result = clone(base);
  for (const [section, fields] of Object.entries(SECTIONS)) {
    if (!patch?.[section] || typeof patch[section] !== 'object' || Array.isArray(patch[section])) continue;
    for (const [field, type] of Object.entries(fields)) {
      const value = patch[section][field];
      if (typeof value === type && (type !== 'number' || Number.isFinite(value))) {
        result[section][field] = value;
      }
    }
  }
  return result;
}

function createSystemSettingsService({ db, defaults }) {
  let current = clone(defaults);
  let loaded = false;

  async function load() {
    if (loaded) return clone(current);
    const result = await db.query(
      'SELECT settings FROM observe_system_settings WHERE tenant_id = current_tenant() LIMIT 1',
    );
    current = mergeSettings(defaults, result.rows[0]?.settings || {});
    loaded = true;
    return clone(current);
  }

  async function update(patch) {
    if (!loaded) await load();
    const next = mergeSettings(current, patch);
    await db.query(
      `INSERT INTO observe_system_settings (tenant_id, settings, updated_at)
       VALUES (current_tenant(), $1::jsonb, NOW())
       ON CONFLICT (tenant_id) DO UPDATE
       SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [JSON.stringify(next)],
    );
    current = next;
    return clone(current);
  }

  return { load, update };
}

module.exports = { createSystemSettingsService, mergeSettings };
