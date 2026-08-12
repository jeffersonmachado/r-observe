BEGIN;

-- Backups e cache SNMP nasceram com escopo tenant/site. Em sites com mais de
-- um edge, hosts iguais não podem compartilhar histórico nem cache.
ALTER TABLE observe_config_backups
  ADD COLUMN IF NOT EXISTS edge_id TEXT NOT NULL DEFAULT 'central';
CREATE INDEX IF NOT EXISTS idx_config_backups_scope_host_collected
  ON observe_config_backups (tenant_id, site_id, edge_id, host, collected_at DESC);

ALTER TABLE observe_snmp_metrics_cache
  ADD COLUMN IF NOT EXISTS edge_id TEXT NOT NULL DEFAULT 'central';
ALTER TABLE observe_snmp_metrics_cache
  DROP CONSTRAINT IF EXISTS observe_snmp_metrics_cache_tenant_id_site_id_host_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_snmp_metrics_cache_scope_host
  ON observe_snmp_metrics_cache (tenant_id, site_id, edge_id, host);

COMMIT;
