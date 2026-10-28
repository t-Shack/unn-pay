'use strict';

const { Op } = require('sequelize');
const {
  Transaction: TransactionModel,
  UnappliedPayment,
  IdempotencyKey,
  RefreshToken,
  sequelize,
} = require('../../models');
const bankAdapters = require('../../adapters/bank');
const audit = require('../../services/auditService');
const { logger } = require('../../config/logger');

/**
 * Daily maintenance (§9.2, §10).
 *
 * Three jobs that must run once a day:
 *   1. expire stale Pending transactions and release their virtual accounts
 *   2. move unapplied payments past their 90 day deadline to Expired
 *   3. clear out expired idempotency keys and dead refresh tokens
 */

/**
 * Expire Pending transactions past expires_at and release the virtual account
 * the bank is still holding open for them (§6).
 *
 * Each transaction is expired in its own database transaction under a row lock,
 * so a settlement arriving at the same moment either wins the race and settles,
 * or finds the row already Expired and opens an unapplied payment instead. What
 * cannot happen is money arriving against an account we have already released
 * without a record of it.
 */
async function expireStaleTransactions({ now = new Date(), limit = 1000 } = {}) {
  const stale = await TransactionModel.findAll({
    where: { status: TransactionModel.STATUS.PENDING, expires_at: { [Op.lt]: now } },
    order: [['expires_at', 'ASC']],
    limit,
  });

  let expired = 0;
  let released = 0;

  for (const candidate of stale) {
    let toRelease = null;

    await sequelize.transaction(async (t) => {
      const transaction = await TransactionModel.findByPk(candidate.transaction_id, {
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      // Re-check under the lock: a webhook may have settled it in the meantime.
      if (!transaction || transaction.status !== TransactionModel.STATUS.PENDING) return;
      if (transaction.expires_at >= now) return;

      const before = transaction.toJSON();
      await transaction.update({ status: TransactionModel.STATUS.EXPIRED }, { transaction: t });

      await audit.recordSystem({
        action: audit.ACTION.TRANSACTION_EXPIRED,
        entityType: 'transaction',
        entityId: transaction.transaction_id,
        before,
        after: transaction.toJSON(),
        transaction: t,
      });

      expired += 1;
      if (transaction.virtual_account_reference && !transaction.virtual_account_released_at) {
        toRelease = transaction;
      }
    });

    // The bank call happens after the commit, never inside it.
    if (toRelease) {
      try {
        const adapter = bankAdapters.getForTransaction(toRelease);
        await adapter.releaseVirtualAccount(toRelease.virtual_account_reference);
        await toRelease.update({ virtual_account_released_at: new Date() });
        released += 1;
      } catch (error) {
        // Not fatal: the account expires at the bank on its own schedule too.
        logger.warn(
          { transaction_id: toRelease.transaction_id, err: error.message },
          'could not release virtual account'
        );
      }
    }
  }

  if (expired > 0) logger.info({ expired, released }, 'expired stale pending transactions');
  return { examined: stale.length, expired, released };
}

/**
 * Move open unapplied payments past their deadline to Expired (§10).
 *
 * "Expired" here means only that it stops appearing in the student's app. The
 * row is never deleted, stays permanently visible to Bursary, stays in the audit
 * log, and can still be resolved manually at any later date. Automatically
 * forfeiting money a student genuinely sent would carry real legal exposure.
 */
async function expireUnappliedPayments({ now = new Date(), limit = 1000 } = {}) {
  const overdue = await UnappliedPayment.findAll({
    where: { status: 'open', deadline_at: { [Op.lt]: now } },
    order: [['deadline_at', 'ASC']],
    limit,
  });

  let expired = 0;

  for (const candidate of overdue) {
    await sequelize.transaction(async (t) => {
      const row = await UnappliedPayment.findByPk(candidate.unapplied_id, {
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
      if (!row || row.status !== 'open' || row.deadline_at >= now) return;

      const before = row.toJSON();
      await row.update({ status: 'expired' }, { transaction: t });

      await audit.recordSystem({
        action: audit.ACTION.UNAPPLIED_EXPIRED,
        entityType: 'unapplied_payment',
        entityId: row.unapplied_id,
        before,
        after: row.toJSON(),
        transaction: t,
      });

      expired += 1;
    });
  }

  if (expired > 0) {
    logger.info(
      { expired },
      'unapplied payments passed their deadline; retained permanently and still resolvable'
    );
  }
  return { examined: overdue.length, expired };
}

/** Housekeeping. Neither table is a source of truth; both grow without bound. */
async function purgeExpiredRecords({ now = new Date() } = {}) {
  const idempotencyKeys = await IdempotencyKey.destroy({
    where: { expires_at: { [Op.lt]: now } },
  });

  // Keep revoked and consumed tokens for 30 days past expiry: they are evidence
  // when investigating a suspected token theft.
  const refreshTokens = await RefreshToken.destroy({
    where: { expires_at: { [Op.lt]: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } },
  });

  if (idempotencyKeys > 0 || refreshTokens > 0) {
    logger.info({ idempotencyKeys, refreshTokens }, 'purged expired records');
  }
  return { idempotency_keys: idempotencyKeys, refresh_tokens: refreshTokens };
}

async function runDailyMaintenance({ now = new Date() } = {}) {
  return {
    transactions: await expireStaleTransactions({ now }),
    unapplied: await expireUnappliedPayments({ now }),
    purged: await purgeExpiredRecords({ now }),
  };
}

module.exports = {
  runDailyMaintenance,
  expireStaleTransactions,
  expireUnappliedPayments,
  purgeExpiredRecords,
};
