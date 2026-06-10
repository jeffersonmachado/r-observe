-- Migration 010: Sessões web e RBAC para o R-Observe.
-- Usa os usuários existentes do IcingaWeb2 como identidade operacional.

CREATE TABLE IF NOT EXISTS observe_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT        NOT NULL UNIQUE,
  username    TEXT        NOT NULL,
  role        TEXT        NOT NULL DEFAULT 'operator',
  user_agent  TEXT,
  ip          TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observe_sessions_username ON observe_sessions (lower(username));
CREATE INDEX IF NOT EXISTS idx_observe_sessions_expires  ON observe_sessions (expires_at);
