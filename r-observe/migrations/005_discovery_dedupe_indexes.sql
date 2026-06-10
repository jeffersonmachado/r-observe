-- Migration 005: Dedupe/consistency indexes for Discovery Engine

CREATE UNIQUE INDEX IF NOT EXISTS uq_observe_topology_edges_dedupe
  ON observe_topology_edges (tenant_id, site_id, edge_id, from_asset_id, to_asset_ref, edge_type, protocol);

CREATE INDEX IF NOT EXISTS idx_observe_dependencies_scope
  ON observe_dependencies (tenant_id, site_id, edge_id, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_observe_discovery_targets_addr
  ON observe_discovery_targets (tenant_id, site_id, edge_id, address);
