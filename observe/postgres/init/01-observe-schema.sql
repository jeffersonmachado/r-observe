-- ─── R-Observe: Schema principal ────────────────────────────────────────────
-- Executado pelo PostgreSQL na primeira inicialização do container.

SET client_encoding = 'UTF8';

-- Extensão para UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Hosts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observe_hosts (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    address     TEXT,
    status      TEXT        NOT NULL DEFAULT 'unknown',
    last_check  TIMESTAMPTZ,
    metadata    JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observe_hosts_name   ON observe_hosts (name);
CREATE INDEX IF NOT EXISTS idx_observe_hosts_status ON observe_hosts (status);

-- ─── Services ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observe_services (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id     UUID        REFERENCES observe_hosts (id) ON DELETE SET NULL,
    name        TEXT        NOT NULL,
    status      TEXT        NOT NULL DEFAULT 'unknown',
    last_check  TIMESTAMPTZ,
    output      TEXT,
    metadata    JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (host_id, name)
);

CREATE INDEX IF NOT EXISTS idx_observe_services_host   ON observe_services (host_id);
CREATE INDEX IF NOT EXISTS idx_observe_services_status ON observe_services (status);

-- ─── Incidents ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observe_incidents (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    title            TEXT        NOT NULL,
    severity         TEXT        NOT NULL DEFAULT 'unknown',
    status           TEXT        NOT NULL DEFAULT 'open',
    source           TEXT,
    source_event_id  TEXT,
    host_id          UUID        REFERENCES observe_hosts (id) ON DELETE SET NULL,
    ai_summary       TEXT,
    ai_cause         TEXT,
    ai_suggestion    TEXT,
    ai_pattern       TEXT,
    metadata         JSONB       NOT NULL DEFAULT '{}',
    evidence_paths   JSONB       NOT NULL DEFAULT '[]',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_observe_incidents_status     ON observe_incidents (status);
CREATE INDEX IF NOT EXISTS idx_observe_incidents_severity   ON observe_incidents (severity);
CREATE INDEX IF NOT EXISTS idx_observe_incidents_host       ON observe_incidents (host_id);
CREATE INDEX IF NOT EXISTS idx_observe_incidents_created    ON observe_incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observe_incidents_source_evt ON observe_incidents (source_event_id)
    WHERE source_event_id IS NOT NULL;

-- ─── Incident Events (timeline) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observe_incident_events (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id  UUID        NOT NULL REFERENCES observe_incidents (id) ON DELETE CASCADE,
    event_type   TEXT        NOT NULL,
    source       TEXT,
    payload      JSONB       NOT NULL DEFAULT '{}',
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observe_inc_events_incident ON observe_incident_events (incident_id);
CREATE INDEX IF NOT EXISTS idx_observe_inc_events_occurred ON observe_incident_events (occurred_at DESC);

-- ─── Remediations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observe_remediations (
    id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id      UUID           NOT NULL REFERENCES observe_incidents (id) ON DELETE CASCADE,
    action           TEXT           NOT NULL,
    params           JSONB          NOT NULL DEFAULT '{}',
    reason           TEXT,
    status           TEXT           NOT NULL DEFAULT 'pending_approval',
    confidence_score NUMERIC(3,2),
    auto_executed    BOOLEAN        NOT NULL DEFAULT false,
    requested_by     TEXT,
    approved_by      TEXT,
    executed_at      TIMESTAMPTZ,
    execution_output TEXT,
    requested_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observe_remediations_incident ON observe_remediations (incident_id);
CREATE INDEX IF NOT EXISTS idx_observe_remediations_status   ON observe_remediations (status);
