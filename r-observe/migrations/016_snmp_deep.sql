-- Migration 016: SNMP Profundo + IPAM + Alerting + Config Backup
-- Data: 2026-06-11
-- Gaps cobertos: SNMP walk, interfaces L2/L3, VLANs, Entity-MIB, ARP table,
--                  IPAM, Alerting Engine, Config Backup, BGP/OSPF/VRRP

BEGIN;

-- ── SNMP Deep Discovery Results ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS observe_snmp_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    site_id         TEXT NOT NULL DEFAULT 'default-site',
    edge_id         TEXT NOT NULL DEFAULT 'central',
    asset_id        UUID REFERENCES observe_assets(id) ON DELETE CASCADE,
    host            TEXT NOT NULL,

    -- System
    sys_descr       TEXT,
    sys_object_id   TEXT,
    sys_name        TEXT,
    sys_uptime      TEXT,
    sys_contact     TEXT,
    sys_location    TEXT,
    sys_services    INTEGER,

    -- Classificação por sysObjectID
    classification  JSONB,

    -- Interfaces (JSONB array)
    interfaces      JSONB DEFAULT '[]',
    interface_count INTEGER DEFAULT 0,

    -- VLANs (JSONB array)
    vlans           JSONB DEFAULT '[]',

    -- ARP Table (JSONB array)
    arp_table       JSONB DEFAULT '[]',

    -- Entity / Hardware
    entity          JSONB,
    serial_number   TEXT,
    model           TEXT,

    -- CPU
    cpu             JSONB,

    -- Memory
    memory          JSONB,

    -- Storage (JSONB array)
    storage         JSONB DEFAULT '[]',

    -- Wireless (JSONB)
    wireless        JSONB,

    -- Routing Protocols (JSONB)
    ospf            JSONB,
    bgp             JSONB,
    vrrp            JSONB,

    -- Metadata
    reachable       BOOLEAN DEFAULT false,
    auth_failure    BOOLEAN DEFAULT false,
    errors          JSONB DEFAULT '[]',
    collected_at    TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (tenant_id, site_id, edge_id, host)
);

CREATE INDEX IF NOT EXISTS idx_snmp_results_host ON observe_snmp_results(host);
CREATE INDEX IF NOT EXISTS idx_snmp_results_asset ON observe_snmp_results(asset_id);
CREATE INDEX IF NOT EXISTS idx_snmp_results_collected ON observe_snmp_results(collected_at DESC);

-- ── IPAM Subnets ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS observe_ipam_subnets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    site_id         TEXT NOT NULL DEFAULT 'default-site',

    cidr            TEXT NOT NULL,
    name            TEXT,
    description     TEXT,
    network_addr    INET NOT NULL,
    broadcast_addr  INET NOT NULL,
    netmask         INET NOT NULL,
    prefix_len      INTEGER NOT NULL,
    total_hosts     INTEGER NOT NULL,
    usable_hosts    INTEGER NOT NULL,

    parent_id       UUID REFERENCES observe_ipam_subnets(id) ON DELETE SET NULL,
    vlan_id         INTEGER,
    gateway         INET,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (tenant_id, site_id, cidr)
);

CREATE INDEX IF NOT EXISTS idx_ipam_subnets_network ON observe_ipam_subnets(network_addr);
CREATE INDEX IF NOT EXISTS idx_ipam_subnets_parent ON observe_ipam_subnets(parent_id);

-- ── IPAM IPs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS observe_ipam_ips (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip              INET NOT NULL UNIQUE,
    subnet_cidr     TEXT NOT NULL,
    hostname        TEXT,
    mac             TEXT,
    status          TEXT NOT NULL DEFAULT 'active', -- active, reserved, deprecated
    asset_id        UUID REFERENCES observe_assets(id) ON DELETE SET NULL,

    last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ipam_ips_subnet ON observe_ipam_ips(subnet_cidr);
CREATE INDEX IF NOT EXISTS idx_ipam_ips_mac ON observe_ipam_ips(mac);
CREATE INDEX IF NOT EXISTS idx_ipam_ips_status ON observe_ipam_ips(status);
CREATE INDEX IF NOT EXISTS idx_ipam_ips_asset ON observe_ipam_ips(asset_id);

-- ── Alerts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS observe_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    site_id         TEXT NOT NULL DEFAULT 'default-site',

    rule_name       TEXT NOT NULL,
    rule_id         TEXT,
    severity        TEXT NOT NULL, -- critical, warning, info, ok
    summary         TEXT,
    description     TEXT,

    host            TEXT,
    asset_id        UUID REFERENCES observe_assets(id) ON DELETE SET NULL,
    metric          TEXT,
    value           TEXT,
    threshold       TEXT,

    fingerprint     TEXT NOT NULL,
    eval_results    JSONB,
    transports      JSONB DEFAULT '{}',

    acknowledged    BOOLEAN DEFAULT false,
    acknowledged_by TEXT,
    acknowledged_at TIMESTAMPTZ,

    fired_at        TIMESTAMPTZ DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,

    UNIQUE (fingerprint, fired_at)
);

CREATE INDEX IF NOT EXISTS idx_alerts_severity ON observe_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint ON observe_alerts(fingerprint);
CREATE INDEX IF NOT EXISTS idx_alerts_host ON observe_alerts(host);
CREATE INDEX IF NOT EXISTS idx_alerts_fired ON observe_alerts(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON observe_alerts(resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_asset ON observe_alerts(asset_id);

-- ── Alert Rules ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS observe_alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    site_id         TEXT NOT NULL DEFAULT 'default-site',

    name            TEXT NOT NULL,
    title           TEXT,
    description     TEXT,
    severity        TEXT NOT NULL DEFAULT 'warning',
    logic           TEXT NOT NULL DEFAULT 'and', -- and, or
    conditions      JSONB NOT NULL DEFAULT '[]',
    transports      JSONB NOT NULL DEFAULT '["redisEvent"]',
    transport_config JSONB DEFAULT '{}',
    enabled         BOOLEAN DEFAULT true,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (tenant_id, site_id, name)
);

-- Insere regras padrão
INSERT INTO observe_alert_rules (name, title, description, severity, logic, conditions, transports)
VALUES
('host_down',
 '{{host}} is DOWN',
 'Host {{host}} is not responding to SNMP or ping.',
 'critical', 'and',
 '[{"metric":"snmp_up","operator":"eq","threshold":0}]',
 '["redisEvent","email"]'),
('interface_down',
 'Interface {{metric}} is DOWN on {{host}}',
 'Interface operational status changed to down.',
 'critical', 'and',
 '[{"metric":"if_oper_status","operator":"eq","threshold":2}]',
 '["redisEvent","email"]'),
('cpu_high',
 'CPU usage > {{threshold}}% on {{host}}',
 'CPU idle is below threshold.',
 'warning', 'and',
 '[{"metric":"cpu_idle_pct","operator":"lt","threshold":10,"severity":"critical"},{"metric":"cpu_idle_pct","operator":"lt","threshold":25,"severity":"warning"}]',
 '["redisEvent"]'),
('memory_high',
 'Memory usage > {{threshold}}% on {{host}}',
 'Available memory is below threshold.',
 'warning', 'or',
 '[{"metric":"memory_used_pct","operator":"gte","threshold":95,"severity":"critical"},{"metric":"memory_used_pct","operator":"gte","threshold":90,"severity":"warning"}]',
 '["redisEvent","email"]'),
('storage_high',
 'Storage usage > {{threshold}}% on {{host}}',
 'Storage is nearly full.',
 'warning', 'or',
 '[{"metric":"storage_used_pct","operator":"gte","threshold":95,"severity":"critical"},{"metric":"storage_used_pct","operator":"gte","threshold":90,"severity":"warning"}]',
 '["redisEvent"]'),
('interface_errors',
 'Interface errors detected on {{host}}',
 'Input or output errors increasing.',
 'warning', 'or',
 '[{"metric":"if_in_errors","operator":"rate","threshold":0.5,"severity":"warning"},{"metric":"if_out_errors","operator":"rate","threshold":0.5,"severity":"warning"}]',
 '["redisEvent"]'),
('bgp_peer_down',
 'BGP peer is DOWN on {{host}}',
 'BGP session is not established.',
 'critical', 'and',
 '[{"metric":"bgp_state","operator":"neq","threshold":"established"}]',
 '["redisEvent","email"]'),
('config_changed',
 'Configuration changed on {{host}}',
 'Running configuration has been modified.',
 'info', 'and',
 '[{"metric":"config_changed","operator":"eq","threshold":true}]',
 '["redisEvent","email"]')
ON CONFLICT (tenant_id, site_id, name) DO NOTHING;

-- ── Config Backups ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS observe_config_backups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    site_id         TEXT NOT NULL DEFAULT 'default-site',

    host            TEXT NOT NULL,
    asset_id        UUID REFERENCES observe_assets(id) ON DELETE SET NULL,
    vendor          TEXT,
    method          TEXT, -- ssh_cli, scp, tftp
    success         BOOLEAN DEFAULT false,
    sha256          TEXT,
    lines           INTEGER,
    error           TEXT,
    config_text     TEXT,

    collected_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_backups_host ON observe_config_backups(host);
CREATE INDEX IF NOT EXISTS idx_config_backups_collected ON observe_config_backups(collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_config_backups_asset ON observe_config_backups(asset_id);

-- ── SNMP Metrics Cache ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS observe_snmp_metrics_cache (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL DEFAULT 'default',
    site_id         TEXT NOT NULL DEFAULT 'default-site',
    host            TEXT NOT NULL,

    snmp_up         SMALLINT DEFAULT 0,
    cpu_user_pct    REAL,
    cpu_system_pct  REAL,
    cpu_idle_pct   REAL,
    cpu_iowait_pct  REAL,
    mem_total_kb    BIGINT,
    mem_avail_kb    BIGINT,
    mem_used_pct    REAL,
    storage_json    JSONB,

    collected_at    TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (tenant_id, site_id, host)
);

CREATE INDEX IF NOT EXISTS idx_snmp_metrics_cache_host ON observe_snmp_metrics_cache(host);
CREATE INDEX IF NOT EXISTS idx_snmp_metrics_cache_collected ON observe_snmp_metrics_cache(collected_at DESC);

COMMIT;
