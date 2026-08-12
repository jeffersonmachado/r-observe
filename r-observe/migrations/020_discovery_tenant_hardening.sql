BEGIN;

ALTER TABLE observe_ipam_ips ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE observe_ipam_ips ADD COLUMN IF NOT EXISTS site_id TEXT NOT NULL DEFAULT 'default-site';
ALTER TABLE observe_ipam_ips DROP CONSTRAINT IF EXISTS observe_ipam_ips_ip_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_observe_ipam_ips_scope_ip
  ON observe_ipam_ips (tenant_id, site_id, ip);
CREATE INDEX IF NOT EXISTS idx_observe_ipam_ips_scope_subnet
  ON observe_ipam_ips (tenant_id, site_id, subnet_cidr);

COMMIT;
