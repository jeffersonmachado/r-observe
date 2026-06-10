-- Migration 006: Policy controls for throttling/timeout/concurrency

ALTER TABLE IF EXISTS observe_discovery_policies
  ADD COLUMN IF NOT EXISTS host_timeout_ms INTEGER NOT NULL DEFAULT 12000;

ALTER TABLE IF EXISTS observe_discovery_policies
  ADD COLUMN IF NOT EXISTS max_concurrency INTEGER NOT NULL DEFAULT 5;

ALTER TABLE IF EXISTS observe_discovery_policies
  ADD COLUMN IF NOT EXISTS allow_udp BOOLEAN NOT NULL DEFAULT false;
