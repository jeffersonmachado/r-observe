-- Migration 004: Enterprise Discovery Engine (multi-tenant)

CREATE TABLE IF NOT EXISTS observe_discovery_policies (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT        NOT NULL,
  site_id             TEXT        NOT NULL,
  edge_id             TEXT        NOT NULL,
  name                TEXT        NOT NULL,
  scan_profile        TEXT        NOT NULL DEFAULT 'safe' CHECK (scan_profile IN ('safe','balanced','aggressive')),
  active_enabled      BOOLEAN     NOT NULL DEFAULT true,
  passive_enabled     BOOLEAN     NOT NULL DEFAULT true,
  allowed_ranges      JSONB       NOT NULL DEFAULT '[]',
  blocked_ranges      JSONB       NOT NULL DEFAULT '[]',
  max_rate_per_minute INTEGER     NOT NULL DEFAULT 300,
  auto_prometheus_sd  BOOLEAN     NOT NULL DEFAULT true,
  auto_icinga_sync    BOOLEAN     NOT NULL DEFAULT false,
  is_default          BOOLEAN     NOT NULL DEFAULT false,
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_observe_discovery_policies_scope ON observe_discovery_policies (tenant_id, site_id, edge_id);

CREATE TABLE IF NOT EXISTS observe_discovery_targets (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT        NOT NULL,
  site_id        TEXT        NOT NULL,
  edge_id        TEXT        NOT NULL,
  policy_id      UUID        REFERENCES observe_discovery_policies(id) ON DELETE SET NULL,
  discovery_type TEXT        NOT NULL DEFAULT 'ip',
  address        TEXT        NOT NULL,
  label          TEXT,
  enabled        BOOLEAN     NOT NULL DEFAULT true,
  metadata       JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, site_id, edge_id, discovery_type, address)
);
CREATE INDEX IF NOT EXISTS idx_observe_discovery_targets_scope ON observe_discovery_targets (tenant_id, site_id, edge_id, enabled);

CREATE TABLE IF NOT EXISTS observe_discovery_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT        NOT NULL,
  site_id      TEXT        NOT NULL,
  edge_id      TEXT        NOT NULL,
  policy_id    UUID        REFERENCES observe_discovery_policies(id) ON DELETE SET NULL,
  status       TEXT        NOT NULL DEFAULT 'running',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  summary      JSONB       NOT NULL DEFAULT '{}',
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_observe_discovery_runs_scope ON observe_discovery_runs (tenant_id, site_id, edge_id, started_at DESC);

CREATE TABLE IF NOT EXISTS observe_assets (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT        NOT NULL,
  site_id          TEXT        NOT NULL,
  edge_id          TEXT        NOT NULL,
  asset_key        TEXT        NOT NULL,
  asset_name       TEXT        NOT NULL,
  display_name     TEXT,
  asset_type       TEXT        NOT NULL DEFAULT 'host',
  vendor           TEXT,
  product          TEXT,
  os_hint          TEXT,
  primary_ip       TEXT,
  hostname         TEXT,
  lifecycle_state  TEXT        NOT NULL DEFAULT 'discovered' CHECK (lifecycle_state IN ('discovered','approved','monitored','ignored','quarantined','disappeared')),
  criticality      TEXT        NOT NULL DEFAULT 'medium',
  confidence       NUMERIC(4,3) NOT NULL DEFAULT 0.500,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, site_id, edge_id, asset_key)
);
CREATE INDEX IF NOT EXISTS idx_observe_assets_scope ON observe_assets (tenant_id, site_id, edge_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_observe_assets_state ON observe_assets (lifecycle_state);

CREATE TABLE IF NOT EXISTS observe_asset_interfaces (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT        NOT NULL,
  site_id      TEXT        NOT NULL,
  edge_id      TEXT        NOT NULL,
  asset_id     UUID        NOT NULL REFERENCES observe_assets(id) ON DELETE CASCADE,
  interface_key TEXT       NOT NULL,
  name         TEXT,
  mac_address  TEXT,
  mac_oui      TEXT,
  ip_address   TEXT,
  network_cidr TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, site_id, edge_id, asset_id, interface_key)
);

CREATE TABLE IF NOT EXISTS observe_asset_services (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  site_id       TEXT        NOT NULL,
  edge_id       TEXT        NOT NULL,
  asset_id      UUID        NOT NULL REFERENCES observe_assets(id) ON DELETE CASCADE,
  service_key   TEXT        NOT NULL,
  service_name  TEXT,
  protocol      TEXT,
  port          INTEGER,
  status        TEXT        NOT NULL DEFAULT 'open',
  fingerprint   JSONB       NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, site_id, edge_id, asset_id, service_key)
);
CREATE INDEX IF NOT EXISTS idx_observe_asset_services_port ON observe_asset_services (port);

CREATE TABLE IF NOT EXISTS observe_discovery_findings (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID        REFERENCES observe_discovery_runs(id) ON DELETE SET NULL,
  tenant_id    TEXT        NOT NULL,
  site_id      TEXT        NOT NULL,
  edge_id      TEXT        NOT NULL,
  finding_type TEXT        NOT NULL,
  severity     TEXT        NOT NULL DEFAULT 'info',
  source       TEXT,
  asset_key    TEXT,
  payload      JSONB       NOT NULL DEFAULT '{}',
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_observe_discovery_findings_run ON observe_discovery_findings (run_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS observe_service_fingerprints (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT        NOT NULL,
  site_id     TEXT        NOT NULL,
  edge_id     TEXT        NOT NULL,
  asset_id    UUID        REFERENCES observe_assets(id) ON DELETE SET NULL,
  service_key TEXT        NOT NULL,
  fingerprint JSONB       NOT NULL DEFAULT '{}',
  confidence  NUMERIC(4,3) NOT NULL DEFAULT 0.500,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_observe_service_fingerprints_asset ON observe_service_fingerprints (asset_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS observe_topology_edges (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  site_id       TEXT        NOT NULL,
  edge_id       TEXT        NOT NULL,
  run_id        UUID        REFERENCES observe_discovery_runs(id) ON DELETE SET NULL,
  from_asset_id UUID        REFERENCES observe_assets(id) ON DELETE SET NULL,
  to_asset_ref  TEXT        NOT NULL,
  edge_type     TEXT        NOT NULL,
  protocol      TEXT,
  source        TEXT,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata      JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_observe_topology_edges_scope ON observe_topology_edges (tenant_id, site_id, edge_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS observe_dependencies (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT        NOT NULL,
  site_id          TEXT        NOT NULL,
  edge_id          TEXT        NOT NULL,
  upstream_asset_id UUID       REFERENCES observe_assets(id) ON DELETE SET NULL,
  downstream_asset_id UUID     REFERENCES observe_assets(id) ON DELETE SET NULL,
  dependency_type  TEXT        NOT NULL,
  confidence       NUMERIC(4,3) NOT NULL DEFAULT 0.500,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS observe_asset_changes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT        NOT NULL,
  site_id      TEXT        NOT NULL,
  edge_id      TEXT        NOT NULL,
  asset_id     UUID        REFERENCES observe_assets(id) ON DELETE CASCADE,
  run_id       UUID        REFERENCES observe_discovery_runs(id) ON DELETE SET NULL,
  change_type  TEXT        NOT NULL,
  field_name   TEXT,
  old_value    TEXT,
  new_value    TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata     JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_observe_asset_changes_asset ON observe_asset_changes (asset_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS observe_asset_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  site_id       TEXT        NOT NULL,
  edge_id       TEXT        NOT NULL,
  asset_id      UUID        REFERENCES observe_assets(id) ON DELETE CASCADE,
  snapshot      JSONB       NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot_type TEXT        NOT NULL DEFAULT 'periodic'
);
CREATE INDEX IF NOT EXISTS idx_observe_asset_history_asset ON observe_asset_history (asset_id, captured_at DESC);

INSERT INTO observe_discovery_policies
  (tenant_id, site_id, edge_id, name, scan_profile, active_enabled, passive_enabled, allowed_ranges, blocked_ranges, max_rate_per_minute, auto_prometheus_sd, auto_icinga_sync, is_default, metadata)
VALUES
  ('default', 'default-site', 'central', 'default-safe', 'safe', true, true, '["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"]', '[]', 300, true, false, true, '{"note":"safe by default"}')
ON CONFLICT DO NOTHING;
