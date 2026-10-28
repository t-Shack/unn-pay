'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations');

/**
 * Run every migration in filename order against the given Sequelize instance.
 * The test suite uses the same migration files production does, so a schema
 * mistake fails a test rather than a deployment.
 */
async function runMigrations(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    await migration.up(queryInterface, sequelize.constructor);
  }
  return files;
}

async function revertMigrations(sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort().reverse();
  for (const file of files) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    await migration.down(queryInterface, sequelize.constructor);
  }
}

module.exports = { runMigrations, revertMigrations, MIGRATIONS_DIR };
