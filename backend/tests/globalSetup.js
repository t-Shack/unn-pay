'use strict';

/**
 * Jest global setup: start one real PostgreSQL 17 server for the whole run and
 * apply every migration to it, so the suite tests the schema production gets.
 */
const { start } = require('./helpers/pg');

module.exports = async () => {
  const started = Date.now();
  const { pg, url } = await start();

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = 'false';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-'.padEnd(48, 'x');
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-'.padEnd(48, 'y');
  process.env.RECEIPT_SIGNING_SECRET = 'test-receipt-secret-'.padEnd(48, 'z');
  process.env.BANK_WEBHOOK_SECRET = 'test-webhook-secret-abcdef';
  process.env.LOG_LEVEL = 'silent';

  const { sequelize } = require('../src/db');
  const { runMigrations } = require('./helpers/migrate');
  await runMigrations(sequelize);
  await sequelize.close();

  globalThis.__UNN_PG__ = pg;
  // eslint-disable-next-line no-console
  console.log(`\n  PostgreSQL 17 ready and migrated in ${Date.now() - started}ms\n`);
};
