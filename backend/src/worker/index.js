'use strict';

const cron = require('node-cron');
const config = require('../config');
const { logger } = require('../config/logger');
const sentry = require('../config/sentry');
const { assertDatabaseConnection, sequelize } = require('../db');
const { runOutboxDrain } = require('./jobs/outboxDrain');
const { runReconciliation, retryFailedWebhooks } = require('./jobs/reconcile');
const { runDailyMaintenance } = require('./jobs/dailyMaintenance');

/**
 * The background worker (§4, §12).
 *
 * A separate process from the API, deployed as its own Render service. A slow
 * reconciliation sweep must never block a student's request, and if the API
 * restarts mid sweep the sweep must not be lost — neither is true of a
 * setInterval living inside the web process.
 *
 * Schedules:
 *   outbox drain          every minute
 *   reconciliation sweep  every 10 minutes  (§9.2)
 *   daily maintenance     once a day        (§9.2, §10)
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'unn-pay-worker';

const tasks = [];
let shuttingDown = false;
/** Jobs never overlap themselves: a slow sweep skips its next tick, not queues it. */
const running = new Set();

/**
 * Wrap a job so it can never overlap itself, always logs its duration, and
 * never takes the worker down when it throws.
 */
function guard(name, job) {
  return async () => {
    if (shuttingDown) return;
    if (running.has(name)) {
      logger.warn({ job: name }, 'previous run still in progress; skipping this tick');
      return;
    }

    running.add(name);
    const startedAt = Date.now();
    try {
      const result = await job();
      logger.info({ job: name, duration_ms: Date.now() - startedAt, result }, 'job complete');
    } catch (error) {
      logger.error(
        { job: name, duration_ms: Date.now() - startedAt, err: error.message, stack: error.stack },
        'job failed'
      );
      sentry.captureException(error, { job: name });
    } finally {
      running.delete(name);
    }
  };
}

const jobs = {
  outbox: guard('outbox_drain', () => runOutboxDrain()),
  reconcile: guard('reconciliation', async () => ({
    sweep: await runReconciliation(),
    webhook_replay: await retryFailedWebhooks(),
  })),
  daily: guard('daily_maintenance', () => runDailyMaintenance()),
};

/**
 * Schedule the jobs. Used by the standalone worker below, and by the API itself
 * when RUN_WORKER_IN_API is set (a free hosting tier with no background worker
 * service). The database connection is the caller's concern.
 */
async function startScheduler() {
  logger.info(
    {
      adapter: config.BANK_ADAPTER,
      outbox: config.OUTBOX_CRON,
      reconcile: config.RECONCILE_CRON,
      daily: config.DAILY_MAINTENANCE_CRON,
    },
    'worker starting'
  );

  tasks.push(cron.schedule(config.OUTBOX_CRON, jobs.outbox, { timezone: 'UTC' }));
  tasks.push(cron.schedule(config.RECONCILE_CRON, jobs.reconcile, { timezone: 'UTC' }));
  tasks.push(cron.schedule(config.DAILY_MAINTENANCE_CRON, jobs.daily, { timezone: 'UTC' }));

  // A restart should not leave a backlog waiting for the next tick.
  await jobs.outbox();

  logger.info('worker ready');
}

/** Stop scheduling, and let an in flight job finish rather than killing it mid settlement. */
async function stopScheduler() {
  shuttingDown = true;
  for (const task of tasks) task.stop();

  const deadline = Date.now() + 25000;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (running.size > 0) {
    logger.warn({ jobs: [...running] }, 'shutting down with jobs still running');
  }
}

async function start() {
  sentry.init({ serviceName: 'unn-pay-worker' });
  await assertDatabaseConnection();
  await startScheduler();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  logger.info({ signal }, 'worker shutting down');

  await stopScheduler();

  await sentry.flush();
  await sequelize.close();
  logger.info('worker stopped');
  process.exit(0);
}

// Process level handlers belong only to the standalone worker. When the API
// hosts the scheduler, the API's own handlers own shutdown.
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection in worker');
    sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });

  start().catch((error) => {
    logger.fatal({ err: error.message, stack: error.stack }, 'worker failed to start');
    process.exit(1);
  });
}

module.exports = { start, shutdown, startScheduler, stopScheduler, jobs };
