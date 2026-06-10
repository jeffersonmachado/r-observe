-- Migration 003: Catálogo dinâmico de IA e tabela de feedback

CREATE TABLE IF NOT EXISTS observe_ai_catalog (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    action       TEXT        NOT NULL UNIQUE,
    description  TEXT        NOT NULL,
    risk         TEXT        NOT NULL DEFAULT 'medium' CHECK (risk IN ('none','low','medium','high')),
    params       JSONB       NOT NULL DEFAULT '[]',
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    auto_ok      BOOLEAN     NOT NULL DEFAULT false,
    max_severity TEXT        NOT NULL DEFAULT 'warning',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_catalog_action  ON observe_ai_catalog (action);
CREATE INDEX IF NOT EXISTS idx_ai_catalog_enabled ON observe_ai_catalog (enabled);

CREATE TABLE IF NOT EXISTS observe_ai_feedback (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id  UUID        NOT NULL REFERENCES observe_incidents (id) ON DELETE CASCADE,
    rating       SMALLINT    NOT NULL CHECK (rating IN (-1, 1)),
    comment      TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_incident ON observe_ai_feedback (incident_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_rating   ON observe_ai_feedback (rating);

INSERT INTO observe_ai_catalog (action, description, risk, params, enabled, auto_ok, max_severity)
VALUES
  ('icinga:reschedule', 'Reagenda um check no Icinga2',                  'none',   '["host","service?"]',                    true, true,  'critical'),
  ('icinga:add-host',   'Registra host descoberto no Icinga2',           'low',    '["name","address","display_name?"]',     true, false, 'warning'),
  ('icinga:silence',    'Cria downtime no Icinga2 (silencia alertas)',   'low',    '["host","duration_minutes?","comment?"]',true, false, 'critical'),
  ('icinga:add-comment','Adiciona comentário a host/serviço no Icinga2', 'none',   '["host","comment","service?"]',          true, true,  'critical'),
  ('http:verify',       'Verifica se endpoint HTTP está respondendo',    'none',   '["url"]',                               true, true,  'critical'),
  ('docker:start',      'Inicia container Docker parado',                'low',    '["container"]',                         true, true,  'warning'),
  ('docker:restart',    'Reinicia container Docker',                     'medium', '["container"]',                         true, false, 'warning'),
  ('docker:stop',       'Para container Docker',                         'high',   '["container"]',                         true, false, 'info')
ON CONFLICT (action) DO NOTHING;
