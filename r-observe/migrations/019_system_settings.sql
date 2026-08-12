-- Configurações operacionais editáveis pela UI, isoladas por tenant.
CREATE TABLE IF NOT EXISTS observe_system_settings (
  tenant_id  TEXT PRIMARY KEY DEFAULT current_tenant(),
  settings   JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE observe_system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_system_settings FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'observe_system_settings'
      AND policyname = 'tenant_isolation_system_settings'
  ) THEN
    CREATE POLICY tenant_isolation_system_settings
      ON observe_system_settings FOR ALL
      USING (tenant_id = current_tenant())
      WITH CHECK (tenant_id = current_tenant());
  END IF;
END $$;
