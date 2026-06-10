-- Migration 012: Scan Scheduler (Enterprise)
-- Agendamento de scans automáticos por política.

CREATE TABLE IF NOT EXISTS observe_discovery_schedules (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL,
  site_id         TEXT        NOT NULL DEFAULT 'default-site',
  edge_id         TEXT        NOT NULL DEFAULT 'central',
  policy_id       UUID        REFERENCES observe_discovery_policies(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  cron_expression TEXT        NOT NULL,                -- ex: '0 */6 * * *' (a cada 6h), '0 2 * * *' (diário às 2h)
  profile_override TEXT,                               -- opcional: sobrescreve scan_profile da política
  enabled         BOOLEAN     NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  run_count       INTEGER     NOT NULL DEFAULT 0,
  last_run_status  TEXT,                               -- 'completed', 'failed', 'running'
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observe_discovery_schedules_scope ON observe_discovery_schedules (tenant_id, site_id, edge_id, enabled);
CREATE INDEX IF NOT EXISTS idx_observe_discovery_schedules_next ON observe_discovery_schedules (next_run_at) WHERE enabled = true;

-- ── Quotas por tenant ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observe_tenant_quotas (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL,
  max_assets      INTEGER     NOT NULL DEFAULT 5000,   -- máximo de assets cadastrados
  max_targets     INTEGER     NOT NULL DEFAULT 500,    -- máximo de targets de scan
  max_scans_per_hour INTEGER  NOT NULL DEFAULT 10,     -- máximo de scans por hora
  max_concurrent_scans INTEGER NOT NULL DEFAULT 1,     -- scans simultâneos
  override        BOOLEAN     NOT NULL DEFAULT false,  -- true = configuração manual, false = default
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

-- Insere quota default para o tenant padrão
INSERT INTO observe_tenant_quotas (tenant_id, max_assets, max_targets, max_scans_per_hour, max_concurrent_scans, override)
VALUES ('default', 5000, 500, 10, 1, false)
ON CONFLICT (tenant_id) DO NOTHING;
