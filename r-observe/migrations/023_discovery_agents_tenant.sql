BEGIN;

ALTER TABLE observe_discovery_agents ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE observe_discovery_agents ADD COLUMN IF NOT EXISTS site_id TEXT NOT NULL DEFAULT 'default-site';
ALTER TABLE observe_discovery_agents ADD COLUMN IF NOT EXISTS edge_id TEXT NOT NULL DEFAULT 'central';
ALTER TABLE observe_discovery_agents DROP CONSTRAINT IF EXISTS observe_discovery_agents_agent_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_observe_discovery_agents_scope_id
  ON observe_discovery_agents (tenant_id, site_id, edge_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_observe_discovery_agents_scope_status
  ON observe_discovery_agents (tenant_id, site_id, edge_id, status, last_seen_at DESC);

COMMIT;
