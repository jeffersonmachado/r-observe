-- ─── Physical Layer (L1) — SNMP ifTable + Optical DOM ────────────────────
-- Adiciona colunas de camada física à observe_asset_interfaces
-- e cria tabela de métricas históricas por interface.

-- 1. Colunas físicas na tabela de interfaces
ALTER TABLE observe_asset_interfaces
  ADD COLUMN IF NOT EXISTS if_index       INTEGER,
  ADD COLUMN IF NOT EXISTS if_type        TEXT,
  ADD COLUMN IF NOT EXISTS if_mtu         INTEGER,
  ADD COLUMN IF NOT EXISTS if_speed_bps   BIGINT,
  ADD COLUMN IF NOT EXISTS if_admin_status TEXT,
  ADD COLUMN IF NOT EXISTS if_oper_status  TEXT,
  ADD COLUMN IF NOT EXISTS sfp_metadata   JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS lldp_neighbor  JSONB NOT NULL DEFAULT '{}';

-- 2. Métricas históricas por interface (time-series)
CREATE TABLE IF NOT EXISTS observe_interface_metrics (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL,
  site_id         TEXT        NOT NULL,
  edge_id         TEXT        NOT NULL,
  asset_id        UUID        NOT NULL REFERENCES observe_assets(id) ON DELETE CASCADE,
  interface_key   TEXT        NOT NULL,
  if_in_octets    BIGINT,
  if_out_octets   BIGINT,
  if_in_errors    BIGINT,
  if_out_errors   BIGINT,
  if_in_discards  BIGINT,
  if_out_discards BIGINT,
  sfp_temperature NUMERIC(5,1),
  sfp_tx_power_dbm NUMERIC(6,2),
  sfp_rx_power_dbm NUMERIC(6,2),
  sfp_voltage     NUMERIC(5,2),
  sfp_bias_current NUMERIC(6,2),
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB       NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, site_id, edge_id, asset_id, interface_key, collected_at)
);

CREATE INDEX IF NOT EXISTS idx_interface_metrics_asset
  ON observe_interface_metrics (asset_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_interface_metrics_time
  ON observe_interface_metrics (collected_at DESC);

-- 3. Tabela de MIBs conhecidas (vendor-specific OID mappings)
CREATE TABLE IF NOT EXISTS observe_snmp_mibs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor        TEXT        NOT NULL,
  mib_name      TEXT        NOT NULL,
  oid_prefix    TEXT        NOT NULL,
  description   TEXT,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  UNIQUE (vendor, mib_name)
);

-- MIBs padrão para métricas físicas
INSERT INTO observe_snmp_mibs (id, vendor, mib_name, oid_prefix, description) VALUES
  (gen_random_uuid(), 'standard', 'IF-MIB',        '1.3.6.1.2.1.2.2.1',   'ifTable — standard interface metrics'),
  (gen_random_uuid(), 'standard', 'IF-MIB-X',      '1.3.6.1.2.1.31.1.1.1','ifXTable — 64-bit counters'),
  (gen_random_uuid(), 'standard', 'ENTITY-MIB',    '1.3.6.1.2.1.47.1.1.1','entPhysicalTable — hardware inventory'),
  (gen_random_uuid(), 'standard', 'LLDP-MIB',      '1.0.8802.1.1.2.1.4',   'lldpRemoteSystemsData'),
  (gen_random_uuid(), 'standard', 'EtherLike-MIB', '1.3.6.1.2.1.10.7.2',   'dot3StatsTable — Ethernet errors'),
  (gen_random_uuid(), 'cisco',    'CISCO-ENVMON',   '1.3.6.1.4.1.9.9.13',  'Cisco environmental monitoring'),
  (gen_random_uuid(), 'mikrotik', 'MIKROTIK-MIB',   '1.3.6.1.4.1.14988.1', 'MikroTik RouterOS MIB'),
  (gen_random_uuid(), 'standard', 'DOM-MIB-Generic','1.3.6.1.2.1.10.49.1', 'Optical transceiver DOM')
ON CONFLICT (vendor, mib_name) DO NOTHING;
