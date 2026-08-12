'use strict';

function toPgLikeResult(result, metadata) {
  // Em UPDATE/DELETE sem RETURNING, Sequelize devolve result=[] e mantém a
  // contagem real apenas em metadata.rowCount. SELECT continua usando o array.
  if (typeof metadata?.rowCount === 'number') {
    return { rows: Array.isArray(result) ? result : [], rowCount: metadata.rowCount };
  }
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return { rows: [], rowCount: 0 };
}

function normalizeDbError(error) {
  const cause = error.parent || error.original;
  if (!cause?.message) return error;
  cause.query_name = error.name;
  return cause;
}

function createSequelizeDb({ Sequelize, env, getTenantId, setLocalTenant, sequelizeOverride = null }) {
  const sequelize = sequelizeOverride || new Sequelize(env.DB_NAME, env.DB_USER, env.DB_PASSWORD, {
    host: env.DB_HOST,
    port: parseInt(env.DB_PORT || '5432', 10),
    dialect: 'postgres',
    logging: false,
    pool: { max: 10, min: 0, acquire: 5000, idle: 30000 },
    dialectOptions: { statement_timeout: 10000 },
  });

  async function execute(sql, params, transaction) {
    try {
      const options = {
        ...(params.length ? { bind: params } : {}),
        ...(transaction ? { transaction } : {}),
      };
      const [result, metadata] = await sequelize.query(sql, options);
      return toPgLikeResult(result, metadata);
    } catch (error) {
      throw normalizeDbError(error);
    }
  }

  return {
    async query(sql, params = []) {
      const tenantId = getTenantId();
      if (tenantId === 'default') return execute(sql, params);
      return sequelize.transaction(async (transaction) => {
        await setLocalTenant(sequelize, transaction, tenantId);
        return execute(sql, params, transaction);
      });
    },

    async connect() {
      let transaction = null;
      return {
        async query(sql, params = []) {
          const normalized = String(sql).trim().toUpperCase();
          if (normalized === 'BEGIN') {
            transaction = await sequelize.transaction();
            await setLocalTenant(sequelize, transaction, getTenantId());
            return { rows: [], rowCount: 0 };
          }
          if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
            if (transaction) await transaction[normalized.toLowerCase()]();
            transaction = null;
            return { rows: [], rowCount: 0 };
          }
          if (transaction) return execute(sql, params, transaction);
          const tenantId = getTenantId();
          if (tenantId === 'default') return execute(sql, params);
          return sequelize.transaction(async (implicitTransaction) => {
            await setLocalTenant(sequelize, implicitTransaction, tenantId);
            return execute(sql, params, implicitTransaction);
          });
        },
        release() {},
      };
    },

    async close() { await sequelize.close(); },
    async end() { await sequelize.close(); },
  };
}

module.exports = { createSequelizeDb, toPgLikeResult, normalizeDbError };
