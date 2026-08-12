BEGIN;

ALTER TABLE observe_alerts ADD COLUMN IF NOT EXISTS edge_id TEXT NOT NULL DEFAULT 'central';
ALTER TABLE observe_alerts DROP CONSTRAINT IF EXISTS observe_alerts_fingerprint_fired_at_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_observe_alerts_active_fingerprint
  ON observe_alerts (tenant_id, site_id, edge_id, fingerprint)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_observe_alerts_scope_fired
  ON observe_alerts (tenant_id, site_id, edge_id, fired_at DESC);

COMMIT;
