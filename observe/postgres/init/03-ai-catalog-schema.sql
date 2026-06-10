-- ─── R-Observe: Catálogo dinâmico de IA e feedback ────────────────────────────
-- Migração: criada após o schema inicial. Usa IF NOT EXISTS para ser idempotente.

SET client_encoding = 'UTF8';

-- ─── Catálogo dinâmico de remediação ────────────────────────────────────────
-- Substitui o catálogo fixo do remediation.js. Cada ação pode ser habilitada/
-- desabilitada e configurada sem deploy.
CREATE TABLE IF NOT EXISTS observe_ai_catalog (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    action       TEXT        NOT NULL UNIQUE,  -- ex: "docker:restart"
    description  TEXT        NOT NULL,
    risk         TEXT        NOT NULL DEFAULT 'medium' CHECK (risk IN ('none','low','medium','high')),
    params       JSONB       NOT NULL DEFAULT '[]',   -- lista de nomes de params
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    auto_ok      BOOLEAN     NOT NULL DEFAULT false,  -- permitido para auto-execução
    max_severity TEXT        NOT NULL DEFAULT 'warning',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_catalog_action  ON observe_ai_catalog (action);
CREATE INDEX IF NOT EXISTS idx_ai_catalog_enabled ON observe_ai_catalog (enabled);

-- ─── Feedback sobre análises da IA ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observe_ai_feedback (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id  UUID        NOT NULL REFERENCES observe_incidents (id) ON DELETE CASCADE,
    rating       SMALLINT    NOT NULL CHECK (rating IN (-1, 1)),  -- 1=útil, -1=inútil
    comment      TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_incident ON observe_ai_feedback (incident_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_rating   ON observe_ai_feedback (rating);

-- ─── Seed do catálogo com as ações padrão ────────────────────────────────────
INSERT INTO observe_ai_catalog (action, description, risk, params, enabled, auto_ok, max_severity)
VALUES
  ('icinga:reschedule', 'Reagenda um check no Icinga2',          'none',   '["host","service?"]',             true, true,  'critical'),
  ('icinga:add-host',   'Registra host descoberto no Icinga2',   'low',    '["name","address","display_name?"]',true, false, 'warning'),
  ('icinga:silence',    'Cria downtime no Icinga2 (silencia alertas)', 'low', '["host","duration_minutes?","comment?"]', true, false, 'critical'),
  ('icinga:add-comment','Adiciona comentário a host/serviço no Icinga2', 'none', '["host","comment","service?"]', true, true, 'critical'),
  ('http:verify',       'Verifica se endpoint HTTP está respondendo', 'none', '["url"]',                       true, true,  'critical'),
  ('docker:start',      'Inicia container Docker parado',         'low',    '["container"]',                   true, true,  'warning'),
  ('docker:restart',    'Reinicia container Docker',              'medium', '["container"]',                   true, false, 'warning'),
  ('docker:stop',       'Para container Docker',                  'high',   '["container"]',                   true, false, 'info')
ON CONFLICT (action) DO NOTHING;
