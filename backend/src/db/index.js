'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config');
const { logger } = require('../config/logger');

/**
 * Single Sequelize instance, shared by the API process and the worker process.
 * They run separately (§4) but speak to the same database with the same models.
 */
const sequelize = new Sequelize(config.DATABASE_URL, {
  dialect: 'postgres',
  logging: config.isDevelopment
    ? (sql, timing) => logger.debug({ sql, timing }, 'sequelize')
    : false,
  benchmark: config.isDevelopment,
  pool: {
    max: config.DATABASE_POOL_MAX,
    min: 0,
    idle: 10000,
    acquire: 30000,
  },
  dialectOptions: config.databaseSsl
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {},
  define: {
    underscored: true,
    freezeTableName: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  // Every datetime column is TIMESTAMPTZ and the database runs in UTC (§3.1).
  // Conversion to West Africa Time happens only at the presentation layer.
  timezone: '+00:00',
  // Retry ONLY genuine connection failures. An unqualified `retry` re-runs any
  // failed statement, including one that failed inside a transaction — and once
  // a statement errors, PostgreSQL aborts the transaction, so the retry comes
  // back as "current transaction is aborted" and buries the real error. That
  // turns a constraint violation the application knows how to handle into an
  // opaque failure.
  retry: {
    max: 2,
    match: [
      /SequelizeConnectionError/,
      /SequelizeConnectionRefusedError/,
      /SequelizeHostNotFoundError/,
      /SequelizeHostNotReachableError/,
      /SequelizeInvalidConnectionError/,
      /SequelizeConnectionTimedOutError/,
      /TimeoutError/,
      /ECONNRESET/,
    ],
  },
});

async function assertDatabaseConnection() {
  await sequelize.authenticate();
  await sequelize.query("SET TIME ZONE 'UTC'");
}

module.exports = { sequelize, Sequelize, assertDatabaseConnection };
