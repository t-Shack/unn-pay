'use strict';

/**
 * A real PostgreSQL instance for the test suite.
 *
 * The specification is explicit (§14): concurrency tests run against the real
 * engine, not SQLite, because the behaviour under test is the partial unique
 * index and SELECT ... FOR UPDATE. This starts a throwaway PostgreSQL 17 server
 * on a free port, which every suite reuses.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');

const { STATE_FILE } = require('./pgState');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function start() {
  const port = await freePort();
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unn-pay-pgdata-'));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'unnpay',
    password: 'unnpay',
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unnpay_test');
  const url = `postgres://unnpay:unnpay@127.0.0.1:${port}/unnpay_test`;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ port, databaseDir, url }));
  return { pg, url, port, databaseDir };
}

module.exports = { start, STATE_FILE };
