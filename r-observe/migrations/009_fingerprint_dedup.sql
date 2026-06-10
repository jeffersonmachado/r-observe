-- Migration 006: Deduplicar fingerprints e adicionar constraint única

-- 1. Remover duplicatas de observe_service_fingerprints, mantendo o mais recente por grupo
DELETE FROM observe_service_fingerprints
WHERE id NOT IN (
  SELECT DISTINCT ON (tenant_id, site_id, edge_id, asset_id, service_key)
    id
  FROM observe_service_fingerprints
  ORDER BY tenant_id, site_id, edge_id, asset_id, service_key, observed_at DESC
);

-- 2. Adicionar constraint única para habilitar upsert
CREATE UNIQUE INDEX IF NOT EXISTS uq_observe_service_fingerprints_key
  ON observe_service_fingerprints (tenant_id, site_id, edge_id, asset_id, service_key);

-- 3. Índice para findings por fonte/ativo (acelera consultas de dedup e listagem)
CREATE INDEX IF NOT EXISTS idx_observe_discovery_findings_source_asset
  ON observe_discovery_findings (tenant_id, site_id, edge_id, source, asset_key, observed_at DESC);
