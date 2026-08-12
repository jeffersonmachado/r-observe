'use strict';
const { Sequelize } = require('sequelize');
const tenant = require('./shared/tenant-context');
const { createSequelizeDb } = require('./shared/sequelize-db');

function createDbClient(env = process.env, sequelizeOverride = null) {
  return createSequelizeDb({ Sequelize, env, ...tenant, sequelizeOverride });
}

module.exports = { createDbClient };
