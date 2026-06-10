-- Migration 011: Audit Log para ações administrativas (Enterprise)
-- Registra quem fez o que, quando, de qual IP, com diff antes/depois.

CREATE TABLE IF NOT EXISTS observe_audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT        NOT NULL,
  site_id       TEXT        NOT NULL DEFAULT 'default-site',
  edge_id       TEXT        NOT NULL DEFAULT 'central',
  actor         TEXT        NOT NULL,                -- username ou 'internal'
  actor_role    TEXT        NOT NULL DEFAULT 'operator',
  actor_ip      TEXT,                                -- IP de origem da requisição
  action        TEXT        NOT NULL,                -- 'policy.create', 'target.delete', 'asset.approve', 'scan.trigger', etc.
  resource_type TEXT        NOT NULL,                -- 'policy', 'target', 'asset', 'scan', 'finding'
  resource_id   TEXT,                                -- UUID do recurso afetado
  resource_key  TEXT,                                -- chave alternativa (asset_key, address, etc.)
  summary       TEXT        NOT NULL,                -- descrição legível da ação
  details       JSONB       NOT NULL DEFAULT '{}',   -- payload completo (antes/depois, params)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observe_audit_log_scope  ON observe_audit_log (tenant_id, site_id, edge_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observe_audit_log_actor  ON observe_audit_log (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observe_audit_log_action ON observe_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observe_audit_log_resource ON observe_audit_log (resource_type, resource_id);
