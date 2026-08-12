'use strict';

/**
 * R-Observe — Multi-Tenancy Middleware & Policies
 *
 * Garante isolamento entre tenants em todas as operações.
 *
 * Princípios:
 *   1. Todo recurso tem tenant_id (default: 'default')
 *   2. Middleware injeta tenant_id no contexto da request
 *   3. Row-Level Security (RLS) no PostgreSQL como camada adicional
 *   4. Auditoria registra tenant_id em todas as operações
 */

// ─── Tenant Context Middleware ──────────────────────────────────────────────

/**
 * Extrai tenant_id do token de autenticação ou header.
 * Deve ser executado APÓS o middleware de autenticação.
 */
function tenantContext(req, res, next) {
  // Já resolvido pelo auth middleware
  if (req.auth?.tenantId) {
    req.tenant_id = req.auth.tenantId;
    return next();
  }

  // Header explícito (para M2M)
  const headerTenant = req.headers['x-tenant-id'];
  if (headerTenant) {
    req.tenant_id = String(headerTenant);
    return next();
  }

  // Query param (para APIs públicas com token)
  const queryTenant = req.query.tenant_id;
  if (queryTenant) {
    req.tenant_id = String(queryTenant);
    return next();
  }

  // Default tenant (single-tenant mode)
  req.tenant_id = process.env.R_OBSERVE_TENANT_MODE === 'multi' ? null : 'default';

  if (!req.tenant_id) {
    return res.status(400).json({ error: 'tenant_id é obrigatório em modo multi-tenant' });
  }

  next();
}

// ─── Tenant-Aware Query Builder ─────────────────────────────────────────────

/**
 * Adiciona tenant_id automático às queries.
 * Uso: db.tenantQuery('SELECT * FROM observe_assets', req)
 */
function tenantQuery(db, req) {
  const tenantId = req?.tenant_id || 'default';

  return {
    async query(sql, params = []) {
      // Já tem WHERE tenant_id? Não adiciona de novo
      if (sql.toLowerCase().includes('tenant_id')) {
        return db.query(sql, params);
      }

      // Adiciona tenant_id após WHERE ou como nova cláusula
      let newSql;
      if (sql.toLowerCase().includes('where')) {
        newSql = sql.replace(/WHERE/i, `WHERE tenant_id = $${params.length + 1} AND`);
      } else if (sql.toLowerCase().includes('order by')) {
        newSql = sql.replace(/ORDER BY/i, `WHERE tenant_id = $${params.length + 1} ORDER BY`);
      } else if (sql.toLowerCase().includes('group by')) {
        newSql = sql.replace(/GROUP BY/i, `WHERE tenant_id = $${params.length + 1} GROUP BY`);
      } else if (sql.toLowerCase().includes('returning')) {
        newSql = sql.replace(/RETURNING/i, `WHERE tenant_id = $${params.length + 1} RETURNING`);
      } else if (sql.toLowerCase().includes('limit')) {
        newSql = sql.replace(/LIMIT/i, `WHERE tenant_id = $${params.length + 1} LIMIT`);
      } else {
        // Append as WHERE
        newSql = `${sql} WHERE tenant_id = $${params.length + 1}`;
      }

      return db.query(newSql, [...params, tenantId]);
    },

    async connect() {
      const client = await db.connect();
      const originalQuery = client.query.bind(client);

      client.query = async (sql, params = []) => {
        if (sql.toLowerCase().includes('tenant_id')) {
          return originalQuery(sql, params);
        }

        let newSql;
        if (sql.toLowerCase().includes('where')) {
          newSql = sql.replace(/WHERE/i, `WHERE tenant_id = $${params.length + 1} AND`);
        } else if (sql.toLowerCase().includes('returning')) {
          newSql = sql.replace(/RETURNING/i, `WHERE tenant_id = $${params.length + 1} RETURNING`);
        } else {
          newSql = `${sql} WHERE tenant_id = $${params.length + 1}`;
        }

        return originalQuery(newSql, [...params, tenantId]);
      };

      return client;
    },
  };
}

// ─── PostgreSQL RLS Setup ───────────────────────────────────────────────────

/**
 * SQL para configurar Row-Level Security no PostgreSQL.
 * Deve ser executado como migration.
 */
const RLS_SETUP_SQL = `
-- Habilita RLS nas tabelas principais
ALTER TABLE observe_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_discovery_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_topology_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_remediations ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE observe_discovery_policies ENABLE ROW LEVEL SECURITY;

-- Política: usuário autenticado vê apenas dados do seu tenant
-- O tenant_id é injetado via variável de sessão PostgreSQL
CREATE POLICY tenant_isolation_assets ON observe_assets
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_findings ON observe_discovery_findings
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_topology ON observe_topology_edges
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_incidents ON observe_incidents
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_remediations ON observe_remediations
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_hosts ON observe_hosts
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_services ON observe_services
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true));

-- Admin bypass policy (para operações cross-tenant de administradores)
CREATE POLICY admin_bypass_assets ON observe_assets
  FOR ALL
  USING (current_setting('app.role', true) = 'admin');
`;

// ─── Tenant Provisioning ───────────────────────────────────────────────────

/**
 * Cria um novo tenant.
 */
async function provisionTenant(db, { name, displayName, adminUser, adminPassword }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Cria tenant
    const tenantId = `tenant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await client.query(
      `INSERT INTO observe_tenants (id, name, display_name, status, created_at)
       VALUES ($1, $2, $3, 'active', NOW())`,
      [tenantId, name, displayName || name]
    );

    // Cria admin user para o tenant
    // (depende da integração com @results/auth)
    if (adminUser && adminPassword) {
      await client.query(
        `INSERT INTO icingaweb_user ("name", "active", "password_hash", "ctime", "mtime")
         VALUES ($1, 1, convert_to(crypt($2::text, gen_salt('bf', 12)), 'UTF8'), NOW(), NOW())`,
        [adminUser, adminPassword]
      );
    }

    await client.query('COMMIT');

    return {
      tenant_id: tenantId,
      name,
      display_name: displayName || name,
      admin_user: adminUser || null,
      status: 'active',
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  tenantContext,
  tenantQuery,
  provisionTenant,
  RLS_SETUP_SQL,
};
