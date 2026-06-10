-- Migration 013: Remote Agents + Agent Registry (Enterprise)
-- Suporte a agentes remotos que enviam descobertas para o discovery central.

CREATE TABLE IF NOT EXISTS observe_discovery_agents (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT        NOT NULL UNIQUE,
  hostname     TEXT        NOT NULL,
  subnets      JSONB       NOT NULL DEFAULT '[]',
  capabilities JSONB       NOT NULL DEFAULT '[]',
  version      TEXT        NOT NULL DEFAULT '1.0.0',
  status       TEXT        NOT NULL DEFAULT 'offline',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observe_discovery_agents_status ON observe_discovery_agents (status, last_seen_at DESC);
