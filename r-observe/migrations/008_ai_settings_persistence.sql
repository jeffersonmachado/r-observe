CREATE TABLE IF NOT EXISTS observe_ai_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'mock',
  model TEXT NOT NULL DEFAULT 'auto',
  api_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO observe_ai_settings (id, provider, model, api_key, updated_at)
VALUES (1, 'mock', 'auto', NULL, NOW())
ON CONFLICT (id) DO NOTHING;
