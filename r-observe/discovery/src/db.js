'use strict';

const { Sequelize } = require('sequelize');

function toPgLikeResult(result, metadata) {
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  if (typeof metadata?.rowCount === 'number') {
    return { rows: [], rowCount: metadata.rowCount };
  }
  return { rows: [], rowCount: 0 };
}

function createDbClient(env = process.env) {
  const sequelize = new Sequelize(env.DB_NAME, env.DB_USER, env.DB_PASSWORD, {
    host: env.DB_HOST,
    port: parseInt(env.DB_PORT || '5432', 10),
    dialect: 'postgres',
    logging: false,
    pool: {
      max: 10,
      min: 0,
      acquire: 5000,
      idle: 30000,
    },
    dialectOptions: {
      statement_timeout: 10000,
    },
  });

  return {
    async query(sql, params = []) {
      try {
        const [result, metadata] = await sequelize.query(sql, { bind: params });
        return toPgLikeResult(result, metadata);
      } catch (err) {
        const cause = err.parent || err.original;
        if (cause?.message) {
          cause.query_name = err.name;
          throw cause;
        }
        throw err;
      }
    },
    async close() {
      await sequelize.close();
    },

    async end() {
      await sequelize.close();
    },
  };
}

module.exports = { createDbClient };
