BEGIN;

DELETE FROM observe_dependencies d
USING observe_dependencies newer
WHERE d.tenant_id=newer.tenant_id AND d.site_id=newer.site_id AND d.edge_id=newer.edge_id
  AND d.upstream_asset_id IS NOT DISTINCT FROM newer.upstream_asset_id
  AND d.downstream_asset_id IS NOT DISTINCT FROM newer.downstream_asset_id
  AND d.dependency_type=newer.dependency_type
  AND COALESCE(d.metadata->>'port','')=COALESCE(newer.metadata->>'port','')
  AND COALESCE(d.metadata->>'protocol','')=COALESCE(newer.metadata->>'protocol','')
  AND (d.last_seen_at < newer.last_seen_at OR (d.last_seen_at = newer.last_seen_at AND d.id < newer.id));

CREATE UNIQUE INDEX IF NOT EXISTS uq_observe_dependencies_logical
  ON observe_dependencies (
    tenant_id, site_id, edge_id,
    COALESCE(upstream_asset_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(downstream_asset_id, '00000000-0000-0000-0000-000000000000'::uuid),
    dependency_type,
    COALESCE(metadata->>'port',''),
    COALESCE(metadata->>'protocol','')
  );

COMMIT;
