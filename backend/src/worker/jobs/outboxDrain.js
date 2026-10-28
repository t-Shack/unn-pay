'use strict';

const outboxService = require('../../services/outboxService');
const notificationService = require('../../services/notificationService');
const { logger } = require('../../config/logger');
const { captureException } = require('../../config/sentry');

/**
 * Drain the transactional outbox (§9.3).
 *
 * Claims a batch with SKIP LOCKED, delivers each entry, and either marks it done
 * or schedules a retry with exponential backoff and jitter. Nothing here runs
 * inside a database transaction that touched a payment — that separation is the
 * entire reason the outbox exists.
 */
async function runOutboxDrain({ batchSize = 25, now = new Date() } = {}) {
  // Anything a previous worker claimed and then died holding comes back first.
  await outboxService.recoverStalled({ now });

  const entries = await outboxService.claimBatch({ limit: batchSize, now });
  if (entries.length === 0) return { claimed: 0, delivered: 0, failed: 0, dead: 0 };

  let delivered = 0;
  let failed = 0;
  let dead = 0;

  for (const entry of entries) {
    try {
      await notificationService.dispatch(entry.event_type, entry.payload);
      await outboxService.markDone(entry, { now });
      delivered += 1;
    } catch (error) {
      const result = await outboxService.markFailed(entry, error, { now });
      if (result.status === 'dead') {
        dead += 1;
        captureException(error, {
          outbox_id: entry.outbox_id,
          event_type: entry.event_type,
          attempts: result.attempts,
        });
      } else {
        failed += 1;
      }
      logger.warn(
        {
          outbox_id: entry.outbox_id,
          event_type: entry.event_type,
          attempt: result.attempts,
          status: result.status,
          err: error.message,
        },
        'outbox delivery failed'
      );
    }
  }

  logger.info({ claimed: entries.length, delivered, failed, dead }, 'outbox drain complete');
  return { claimed: entries.length, delivered, failed, dead };
}

module.exports = { runOutboxDrain };
