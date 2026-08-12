-- Migration: 018_multi_tenancy.sql
-- Isolamento multi-tenant por coluna + PostgreSQL Row-Level Security.
-- Idempotente para instalações novas e upgrades de bancos single-tenant.

CREATE TABLE IF NOT EXISTS observe_tenants (
  id           VARCHAR(64) PRIMARY KEY,
  name         VARCHAR(128) NOT NULL UNIQUE,
  display_name VARCHAR(256),
  status       VARCHAR(32) NOT NULL DEFAULT 'active',
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO observe_tenants (id, name, display_name, status)
VALUES ('default', 'default', 'Default Tenant', 'active')
ON CONFLICT (id) DO NOTHING;

-- As tabelas core nasceram antes do modelo tenant/site/edge. A coluna é criada
-- explicitamente antes dos índices para que a migration funcione em banco novo.
ALTER TABLE observe_hosts            ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE observe_services         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE observe_incidents        ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE observe_incident_events  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE observe_remediations     ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE observe_sessions         ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Normaliza dados legados antes de ativar políticas fail-closed.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name LIKE 'observe_%'
      AND table_name <> 'observe_tenants'
      AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('UPDATE %I SET tenant_id = ''default'' WHERE tenant_id IS NULL', tbl);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_observe_assets_tenant         ON observe_assets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observe_incidents_tenant      ON observe_incidents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observe_hosts_tenant          ON observe_hosts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observe_services_tenant       ON observe_services(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observe_remediations_tenant   ON observe_remediations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observe_discovery_runs_tenant ON observe_discovery_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observe_topology_edges_tenant ON observe_topology_edges(tenant_id);
CREATE INDEX IF NOT EXISTS idx_observe_sessions_tenant       ON observe_sessions(tenant_id);

CREATE OR REPLACE FUNCTION current_tenant()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), 'default')::TEXT
$$;

-- Inserts legados que não informam tenant_id herdam o contexto transacional,
-- nunca um valor enviado diretamente pelo cliente.
ALTER TABLE observe_hosts           ALTER COLUMN tenant_id SET DEFAULT current_tenant();
ALTER TABLE observe_services        ALTER COLUMN tenant_id SET DEFAULT current_tenant();
ALTER TABLE observe_incidents       ALTER COLUMN tenant_id SET DEFAULT current_tenant();
ALTER TABLE observe_incident_events ALTER COLUMN tenant_id SET DEFAULT current_tenant();
ALTER TABLE observe_remediations    ALTER COLUMN tenant_id SET DEFAULT current_tenant();

-- Identidades naturais deixam de ser globais entre tenants.
ALTER TABLE observe_hosts DROP CONSTRAINT IF EXISTS observe_hosts_name_key;
ALTER TABLE observe_services DROP CONSTRAINT IF EXISTS observe_services_host_id_name_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observe_hosts_tenant_name_key') THEN
    ALTER TABLE observe_hosts ADD CONSTRAINT observe_hosts_tenant_name_key UNIQUE (tenant_id, name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observe_services_tenant_host_name_key') THEN
    ALTER TABLE observe_services ADD CONSTRAINT observe_services_tenant_host_name_key UNIQUE (tenant_id, host_id, name);
  END IF;
END $$;

-- Todas as tabelas observe_* que possuem tenant_id recebem a mesma política.
-- FORCE também submete o owner da tabela ao RLS, evitando bypass acidental pelo
-- usuário da aplicação. Operações cross-tenant devem usar uma conexão/migração
-- administrativa separada, nunca um header vindo do cliente.
DO $$
DECLARE
  tbl TEXT;
  policy_name TEXT;
BEGIN
  FOR tbl IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name LIKE 'observe_%'
      AND table_name NOT IN ('observe_tenants', 'observe_sessions')
      AND column_name = 'tenant_id'
  LOOP
    policy_name := 'tenant_isolation_' || substr(md5(tbl), 1, 16);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = tbl
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())',
        policy_name,
        tbl
      );
    END IF;
  END LOOP;
END $$;
