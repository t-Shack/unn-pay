'use strict';

/**
 * A local PostgreSQL for development and demonstrations, with nothing to
 * install system wide.
 *
 * Runs the same PostgreSQL 17 the test suite uses (embedded-postgres, a dev
 * dependency) as the user, password, port and database named in DATABASE_URL,
 * and keeps its data in backend/.pgdata so it survives restarts. Leave it
 * running in its own terminal; Ctrl+C stops it cleanly.
 *
 *   npm run db:dev
 */

const fs = require('fs');
const path = require('path');
const loadEnv = require('../config/loadEnv');

loadEnv();

const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run a development database in production.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const url = new URL(process.env.DATABASE_URL);
  const database = url.pathname.replace(/^\//, '');
  const port = Number(url.port || 5432);
  const databaseDir = path.resolve(__dirname, '..', '..', '.pgdata');
  const fresh = !fs.existsSync(path.join(databaseDir, 'PG_VERSION'));

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    port,
    persistent: true,
    onLog: () => {},
  });

  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase(database);

  console.log(`PostgreSQL is running on port ${port} (database "${database}", data in .pgdata).`);
  if (fresh) console.log('New database: now run "npm run migrate" and "npm run seed:demo".');
  console.log('Leave this running. Press Ctrl+C to stop it.');

  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
