'use strict';

const config = require('./config');
const { logger } = require('./config/logger');
const sentry = require('./config/sentry');
const { createApp } = require('./app');
const { assertDatabaseConnection, sequelize } = require('./db');

/**
 * API entry point.
 *
 * Migrations are NOT run here. They run as a release command (§12): two
 * instances starting at once would otherwise race each other through the same
 * migration.
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'unn-pay-api';

let server = null;
let shuttingDown = false;

async function start() {
  sentry.init({ serviceName: 'unn-pay-api' });

  await assertDatabaseConnection();
  logger.info({ adapter: config.BANK_ADAPTER, env: config.NODE_ENV }, 'database connected');

  const app = createApp();

  server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'UNN Pay API listening');
  });

  // A student on a slow connection mid upload must not be cut off by a proxy
  // timing out first; keepAlive is set above the typical 60s load balancer idle.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  return server;
}

/**
 * Graceful shutdown: stop accepting connections, let in flight requests finish,
 * then close the pool. A payment must never be cut in half by a deploy.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.fatal('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 30000);
  force.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('http server closed');
    }
    await sentry.flush();
    await sequelize.close();
    logger.info('database pool closed');
    clearTimeout(force);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error.message }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error.message, stack: error.stack }, 'uncaught exception');
  sentry.captureException(error);
  shutdown('uncaughtException');
});

if (require.main === module) {
  start().catch((error) => {
    logger.fatal({ err: error.message, stack: error.stack }, 'failed to start');
    process.exit(1);
  });
}

module.exports = { start, shutdown };
