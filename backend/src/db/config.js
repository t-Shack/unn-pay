'use strict';

/**
 * Configuration consumed by sequelize-cli when running migrations.
 * Migrations run as a release command (§12), never at server boot, so two
 * instances starting at once can never race each other.
 */
const config = require('../config');

const base = {
  url: config.DATABASE_URL,
  dialect: 'postgres',
  dialectOptions: config.databaseSsl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_seeds',
};

module.exports = { development: base, test: base, production: base };
