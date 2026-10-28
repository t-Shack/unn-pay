'use strict';

const { Op } = require('sequelize');
const { Outbox, sequelize } = require('../models');
const { logger } = require('../config/logger');

/**
 * Transactional outbox (§9.3).
 *
 * FCM and the email provider are never called inside the database transaction
 * that updates a payment. The intent is written to this table in that same
 * transaction, and the worker delivers it afterwards. That way a notification
 * failure can never roll back a settled payment, and a payment that commits can
 * never silently lose its notification.
 *
 * Backoff schedule (§9.3): 1m, 5m, 15m, 1h, 6h, then 6h for the remainder, with
 * jitter, to 8 attempts. After that the entry is dead and shows on the admin
 * dashboard.
 */

const BACKOFF_SCHEDULE_MS = Object.freeze([
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  21_600_000, // 6h
]);

const MAX_ATTEMPTS = 8;
/** ±20% jitter, so a provider outage does not produce a synchronised retry storm. */
const JITTER_RATIO = 0.2;

/**
 * Delay before attempt number `attemptCount + 1`.
 * @param {number} attemptCount attempts already made (0 based)
 * @param {() => number} [random] injectable for deterministic tests
 */
function backoffDelayMs(attemptCount, random = Math.random) {
  const index = Math.min(attemptCount, BACKOFF_SCHEDULE_MS.length - 1);
  const base = BACKOFF_SCHEDULE_MS[index];
  const jitter = base * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}

/**
 * Queue an event for delivery. MUST be given the caller's transaction whenever
 * it accompanies a state change — that is the entire point of the pattern.
 */
async function enqueue(eventType, payload, { transaction, availableAt } = {}) {
  return Outbox.create(
    {
      event_type: eventType,
      payload,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: availableAt || new Date(),
    },
    { transaction }
  );
}

/**
 * Claim a batch of due entries for this worker.
 *
 * SKIP LOCKED means two worker instances can drain concurrently without either
 * blocking on the other or double sending. The claim commits immediately, so a
 * worker that dies mid delivery leaves entries in `processing` rather than
 * silently retrying them forever — `recoverStalled` picks those back up.
 */
async function claimBatch({ limit = 25, now = new Date() } = {}) {
  return sequelize.transaction(async (t) => {
    const rows = await Outbox.findAll({
      where: { status: 'pending', next_attempt_at: { [Op.lte]: now } },
      order: [['next_attempt_at', 'ASC']],
      limit,
      lock: t.LOCK.UPDATE,
      skipLocked: true,
      transaction: t,
    });

    if (rows.length === 0) return [];

    await Outbox.update(
      { status: 'processing', locked_at: now },
      { where: { outbox_id: rows.map((r) => r.outbox_id) }, transaction: t }
    );

    return rows;
  });
}

async function markDone(entry, { now = new Date() } = {}) {
  await Outbox.update(
    {
      status: 'done',
      completed_at: now,
      attempt_count: entry.attempt_count + 1,
      last_error: null,
      locked_at: null,
    },
    { where: { outbox_id: entry.outbox_id } }
  );
}

/**
 * Record a delivery failure and schedule the retry, or bury the entry once it
 * has exhausted its attempts.
 */
async function markFailed(entry, error, { now = new Date(), random = Math.random } = {}) {
  const attempts = entry.attempt_count + 1;
  const message = String((error && error.message) || error || 'unknown').slice(0, 1000);

  if (attempts >= MAX_ATTEMPTS) {
    await Outbox.update(
      { status: 'dead', attempt_count: attempts, last_error: message, locked_at: null },
      { where: { outbox_id: entry.outbox_id } }
    );
    logger.error(
      { outbox_id: entry.outbox_id, event_type: entry.event_type, attempts },
      'outbox entry is dead after exhausting retries'
    );
    return { status: 'dead', attempts };
  }

  const nextAttemptAt = new Date(now.getTime() + backoffDelayMs(attempts, random));
  await Outbox.update(
    {
      status: 'pending',
      attempt_count: attempts,
      last_error: message,
      next_attempt_at: nextAttemptAt,
      locked_at: null,
    },
    { where: { outbox_id: entry.outbox_id } }
  );
  return { status: 'pending', attempts, nextAttemptAt };
}

/**
 * Return entries stuck in `processing` to the queue. A worker killed mid
 * delivery leaves them there; without this they would never be retried.
 */
async function recoverStalled({ olderThanMs = 600_000, now = new Date() } = {}) {
  const [count] = await Outbox.update(
    { status: 'pending', locked_at: null },
    {
      where: {
        status: 'processing',
        locked_at: { [Op.lt]: new Date(now.getTime() - olderThanMs) },
      },
    }
  );
  if (count > 0) logger.warn({ count }, 'recovered stalled outbox entries');
  return count;
}

/** Counts for the admin health panel (§9.6). */
async function stats() {
  const rows = await Outbox.findAll({
    attributes: ['status', [sequelize.fn('COUNT', sequelize.col('outbox_id')), 'count']],
    group: ['status'],
    raw: true,
  });
  const out = { pending: 0, processing: 0, done: 0, dead: 0 };
  for (const row of rows) out[row.status] = Number(row.count);
  return out;
}

module.exports = {
  enqueue,
  claimBatch,
  markDone,
  markFailed,
  recoverStalled,
  stats,
  backoffDelayMs,
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
};
