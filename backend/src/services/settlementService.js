'use strict';

const { UniqueConstraintError } = require('sequelize');
const {
  Transaction: TransactionModel,
  UnappliedPayment,
  Student,
  FeeItem,
  Receipt,
  sequelize,
} = require('../models');
const { toKobo, koboToDecimalString, compareToExpected, subtract } = require('../lib/money');
const receiptService = require('./receiptService');
const outboxService = require('./outboxService');
const audit = require('./auditService');
const { logger, maskAccountNumber } = require('../config/logger');
const config = require('../config');

/**
 * Applying a settlement — the core of the system.
 *
 * Every route by which money can be reported reaches this one function: the
 * bank webhook, the ten minute reconciliation sweep, and the sweep's catch-all
 * listSettlements pass. They race each other by design, so this function is
 * written to be safely called twice with the same settlement, concurrently,
 * from two processes.
 *
 * The guarantees it holds:
 *
 *  1. Idempotent on providerReference. A settlement already applied is a no-op
 *     that reports success (§9.1).
 *  2. Guarded transitions. A transaction only moves Pending -> Successful while
 *     it is genuinely still Pending, decided under SELECT ... FOR UPDATE.
 *  3. No silent absorption. Anything that is not an exact payment against a live
 *     reference opens an unapplied_payments row and issues no receipt (§10).
 *  4. Nothing external is called inside the transaction. Notifications go to the
 *     outbox and are delivered later by the worker (§9.3).
 */

const OUTCOME = Object.freeze({
  SETTLED: 'settled',
  DUPLICATE_IGNORED: 'duplicate_ignored',
  UNAPPLIED_OPENED: 'unapplied_opened',
  FAILED_RECORDED: 'failed_recorded',
  PENDING_IGNORED: 'pending_ignored',
});

const REASON = UnappliedPayment.REASONS;

/**
 * @param {import('../adapters/bank/types').NormalisedSettlement} settlement
 * @param {{source?: 'webhook'|'reconciliation'|'reconciliation_sweep', adapterName?: string}} [context]
 */
async function applySettlement(settlement, { source = 'webhook', adapterName } = {}) {
  const log = logger.child({
    provider_reference: settlement.providerReference,
    unn_reference: settlement.unnReference,
    source,
  });

  // A settlement the bank reports as still pending tells us nothing actionable;
  // the sweep will look again.
  if (settlement.status === 'pending') {
    log.debug('settlement still pending at the bank; ignoring');
    return { outcome: OUTCOME.PENDING_IGNORED };
  }

  try {
    return await sequelize.transaction(async (t) => {
      // --- 1. Idempotency ---------------------------------------------------
      // Keyed on the bank's own settlement id. Banks retry; retries must be
      // harmless, and the sweep frequently races the webhook it compensates for.
      const alreadyApplied = await TransactionModel.findOne({
        where: { provider_reference: settlement.providerReference },
        transaction: t,
      });
      if (alreadyApplied) {
        log.debug({ transaction_id: alreadyApplied.transaction_id }, 'settlement already applied');
        return { outcome: OUTCOME.DUPLICATE_IGNORED, transaction: alreadyApplied };
      }

      const alreadyUnapplied = await UnappliedPayment.findOne({
        where: { provider_reference: settlement.providerReference },
        transaction: t,
      });
      if (alreadyUnapplied) {
        log.debug({ unapplied_id: alreadyUnapplied.unapplied_id }, 'settlement already unapplied');
        return { outcome: OUTCOME.DUPLICATE_IGNORED, unapplied: alreadyUnapplied };
      }

      // --- 2. Locate and lock the transaction -------------------------------
      const transaction = await TransactionModel.findOne({
        where: { unn_reference: settlement.unnReference },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      // Money quoting a reference UNN never minted. Never absorbed silently.
      if (!transaction) {
        log.warn('settlement for an unknown reference');
        const unapplied = await openUnapplied(
          {
            settlement,
            reason: REASON.UNKNOWN_REFERENCE,
            transaction: null,
            student: null,
          },
          t
        );
        return { outcome: OUTCOME.UNAPPLIED_OPENED, unapplied };
      }

      // --- 3. A failed settlement ------------------------------------------
      if (settlement.status === 'failed') {
        if (transaction.status === TransactionModel.STATUS.PENDING) {
          const before = transaction.toJSON();
          await transaction.update(
            { status: TransactionModel.STATUS.FAILED, provider_reference: settlement.providerReference },
            { transaction: t }
          );
          await audit.recordSystem({
            action: audit.ACTION.TRANSACTION_FAILED,
            entityType: 'transaction',
            entityId: transaction.transaction_id,
            before,
            after: transaction.toJSON(),
            transaction: t,
          });
        }
        return { outcome: OUTCOME.FAILED_RECORDED, transaction };
      }

      const student = await Student.findByPk(transaction.student_id, { transaction: t });
      const feeItem = await FeeItem.findByPk(transaction.fee_item_id, { transaction: t });

      // The idempotency check above runs before this row is locked, so under
      // genuine concurrency it can miss: five deliveries of the same webhook all
      // read "not yet applied", then queue on this lock. Whichever loses now
      // sees the winner's provider reference on the row. Same settlement id
      // means the same money, delivered twice — not a second payment.
      if (transaction.provider_reference === settlement.providerReference) {
        log.debug('settlement already applied to this transaction; ignoring the replay');
        return { outcome: OUTCOME.DUPLICATE_IGNORED, transaction };
      }

      // --- 4. Money against an already settled reference --------------------
      if (transaction.status === TransactionModel.STATUS.SUCCESSFUL) {
        log.warn('second payment against an already settled reference');
        const unapplied = await openUnapplied(
          { settlement, reason: REASON.DUPLICATE_PAYMENT, transaction, student },
          t
        );
        return { outcome: OUTCOME.UNAPPLIED_OPENED, unapplied, transaction };
      }

      if (
        transaction.status === TransactionModel.STATUS.FAILED ||
        transaction.status === TransactionModel.STATUS.UNDER_REVIEW
      ) {
        // Already being handled by a human, or already closed out. Record the
        // money so nothing is lost, and let Bursary reconcile it.
        const unapplied = await openUnapplied(
          { settlement, reason: REASON.DUPLICATE_PAYMENT, transaction, student },
          t
        );
        return { outcome: OUTCOME.UNAPPLIED_OPENED, unapplied, transaction };
      }

      // --- 5. Money against an expired reference ----------------------------
      const paidAfterExpiry = settlement.paidAt > transaction.expires_at;
      if (transaction.status === TransactionModel.STATUS.EXPIRED || paidAfterExpiry) {
        log.warn('settlement against an expired reference');
        const unapplied = await openUnapplied(
          { settlement, reason: REASON.EXPIRED_REFERENCE, transaction, student },
          t
        );
        await moveToUnderReview(transaction, settlement, t);
        return { outcome: OUTCOME.UNAPPLIED_OPENED, unapplied, transaction };
      }

      // --- 6. Amount comparison ---------------------------------------------
      const expectedKobo = toKobo(transaction.expected_amount);
      const paidKobo = settlement.amountPaidKobo;
      const comparison = compareToExpected(paidKobo, expectedKobo);

      if (comparison !== 'exact') {
        log.warn({ expectedKobo, paidKobo, comparison }, 'amount mismatch');
        const unapplied = await openUnapplied(
          {
            settlement,
            reason: comparison === 'underpayment' ? REASON.UNDERPAYMENT : REASON.OVERPAYMENT,
            transaction,
            student,
            expectedKobo,
          },
          t
        );
        await moveToUnderReview(transaction, settlement, t);
        return { outcome: OUTCOME.UNAPPLIED_OPENED, unapplied, transaction };
      }

      // --- 7. Exact payment against a live reference: settle -----------------
      const before = transaction.toJSON();
      await transaction.update(
        {
          status: TransactionModel.STATUS.SUCCESSFUL,
          amount_paid: koboToDecimalString(paidKobo),
          provider_reference: settlement.providerReference,
          channel: settlement.channel,
          paid_at: settlement.paidAt,
        },
        { transaction: t }
      );

      const receipt = await receiptService.issueReceipt(transaction, {
        feeItem,
        session: feeItem ? feeItem.session : null,
        transaction: t,
      });

      await audit.recordSystem({
        action: audit.ACTION.TRANSACTION_SETTLED,
        entityType: 'transaction',
        entityId: transaction.transaction_id,
        before,
        after: transaction.toJSON(),
        transaction: t,
      });
      await audit.recordSystem({
        action: audit.ACTION.RECEIPT_ISSUED,
        entityType: 'receipt',
        entityId: receipt.receipt_id,
        after: receipt.toJSON(),
        transaction: t,
      });

      // Notifications go to the outbox inside this same transaction, never over
      // the network from in here (§9.3).
      await outboxService.enqueue(
        'payment.successful',
        {
          student_id: transaction.student_id,
          transaction_id: transaction.transaction_id,
          receipt_id: receipt.receipt_id,
          unn_reference: transaction.unn_reference,
          receipt_number: receipt.receipt_number,
          amount: receipt.amount,
          fee_item_description: receipt.fee_item_description,
        },
        { transaction: t }
      );

      log.info(
        { transaction_id: transaction.transaction_id, receipt_number: receipt.receipt_number },
        'payment settled'
      );

      return { outcome: OUTCOME.SETTLED, transaction, receipt };
    });
  } catch (error) {
    // The partial unique index on (student_id, fee_item_id) WHERE status =
    // 'Successful' is the real double payment guard. If *that* index fires, a
    // concurrent settlement for a different reference against the same fee item
    // won the race: this money is a genuine duplicate and belongs in the
    // unapplied queue, not in a receipt.
    //
    // Only that one constraint means "duplicate payment". Any other unique
    // violation is a bug on our side, and must surface as one rather than being
    // quietly relabelled as the student having paid twice.
    if (isDoublePaymentViolation(error)) {
      logger.warn(
        { provider_reference: settlement.providerReference, constraint: constraintName(error) },
        'double payment guard fired; routing this settlement to the unapplied queue'
      );
      return handleConstraintCollision(settlement, error);
    }

    if (error instanceof UniqueConstraintError) {
      logger.error(
        { provider_reference: settlement.providerReference, constraint: constraintName(error) },
        'unexpected unique constraint violation while settling'
      );
    }
    throw error;
  }
}

const DOUBLE_PAYMENT_INDEX = 'uniq_successful_payment_per_fee_item';

/** The constraint name Postgres reported, whichever field it landed in. */
function constraintName(error) {
  return (
    (error && error.parent && error.parent.constraint) ||
    (error && error.index) ||
    (error && error.fields && Object.keys(error.fields).join(',')) ||
    null
  );
}

/** True only for the partial unique index that guards against double payment. */
function isDoublePaymentViolation(error) {
  return error instanceof UniqueConstraintError && constraintName(error) === DOUBLE_PAYMENT_INDEX;
}

/** A settlement that lost a race with another settlement for the same fee item. */
async function handleConstraintCollision(settlement, cause) {
  return sequelize.transaction(async (t) => {
    const existing = await TransactionModel.findOne({
      where: { provider_reference: settlement.providerReference },
      transaction: t,
    });
    if (existing) return { outcome: OUTCOME.DUPLICATE_IGNORED, transaction: existing };

    const alreadyUnapplied = await UnappliedPayment.findOne({
      where: { provider_reference: settlement.providerReference },
      transaction: t,
    });
    if (alreadyUnapplied) {
      return { outcome: OUTCOME.DUPLICATE_IGNORED, unapplied: alreadyUnapplied };
    }

    const transaction = await TransactionModel.findOne({
      where: { unn_reference: settlement.unnReference },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    const student = transaction
      ? await Student.findByPk(transaction.student_id, { transaction: t })
      : null;

    const unapplied = await openUnapplied(
      {
        settlement,
        reason: REASON.DUPLICATE_PAYMENT,
        transaction,
        student,
        expectedKobo: transaction ? toKobo(transaction.expected_amount) : null,
        note: `Blocked by ${cause.index || 'a uniqueness constraint'}`,
      },
      t
    );

    if (transaction && transaction.status === TransactionModel.STATUS.PENDING) {
      await moveToUnderReview(transaction, settlement, t);
    }

    return { outcome: OUTCOME.UNAPPLIED_OPENED, unapplied, transaction };
  });
}

/**
 * Open an unapplied payment (§10). The transaction never becomes Successful and
 * no receipt is issued; the student and Bursary are both notified, through the
 * outbox, with the exact figures and the deadline stated explicitly.
 */
async function openUnapplied(
  { settlement, reason, transaction, student, expectedKobo = null, note = null },
  t
) {
  const deadlineAt = new Date(
    settlement.paidAt.getTime() + config.UNAPPLIED_RESOLUTION_DAYS * 24 * 60 * 60 * 1000
  );

  const expected =
    expectedKobo !== null
      ? expectedKobo
      : transaction
        ? toKobo(transaction.expected_amount)
        : null;

  // uniq_unapplied_provider_reference means one settlement can only ever open
  // one unapplied row. Hitting it here is the concurrent-delivery case again:
  // another process is recording this same settlement right now.
  const unapplied = await UnappliedPayment.create(
    {
      unn_reference: settlement.unnReference || null,
      transaction_id: transaction ? transaction.transaction_id : null,
      student_id: student ? student.student_id : null,
      provider_reference: settlement.providerReference,
      amount_received: koboToDecimalString(settlement.amountPaidKobo),
      amount_expected: expected !== null ? koboToDecimalString(expected) : null,
      variance:
        expected !== null ? koboToDecimalString(subtract(settlement.amountPaidKobo, expected)) : null,
      reason,
      status: 'open',
      payer_details: {
        payer_account_name: settlement.payerAccountName,
        payer_bank: settlement.payerBank,
        channel: settlement.channel,
        paid_at: settlement.paidAt.toISOString(),
        provider_reference: settlement.providerReference,
        raw_payload: settlement.rawPayload,
      },
      resolution_note: note,
      deadline_at: deadlineAt,
    },
    { transaction: t }
  );

  await audit.recordSystem({
    action: audit.ACTION.UNAPPLIED_OPENED,
    entityType: 'unapplied_payment',
    entityId: unapplied.unapplied_id,
    after: unapplied.toJSON(),
    transaction: t,
  });

  await outboxService.enqueue(
    'payment.unapplied',
    {
      unapplied_id: unapplied.unapplied_id,
      student_id: student ? student.student_id : null,
      transaction_id: transaction ? transaction.transaction_id : null,
      unn_reference: settlement.unnReference || null,
      reason,
      amount_received: unapplied.amount_received,
      amount_expected: unapplied.amount_expected,
      variance: unapplied.variance,
      deadline_at: deadlineAt.toISOString(),
      payer_account_name: settlement.payerAccountName,
      payer_bank: settlement.payerBank,
      payer_account_masked: maskAccountNumber(settlement.rawPayload?.payer_account_number),
    },
    { transaction: t }
  );

  return unapplied;
}

/** Pending or Expired -> UnderReview, recording the money that arrived. */
async function moveToUnderReview(transaction, settlement, t) {
  if (!TransactionModel.canTransition(transaction.status, TransactionModel.STATUS.UNDER_REVIEW)) {
    return transaction;
  }
  const before = transaction.toJSON();
  await transaction.update(
    {
      status: TransactionModel.STATUS.UNDER_REVIEW,
      amount_paid: koboToDecimalString(settlement.amountPaidKobo),
      provider_reference: settlement.providerReference,
      channel: settlement.channel,
      paid_at: settlement.paidAt,
    },
    { transaction: t }
  );
  await audit.recordSystem({
    action: audit.ACTION.TRANSACTION_UNDER_REVIEW,
    entityType: 'transaction',
    entityId: transaction.transaction_id,
    before,
    after: transaction.toJSON(),
    transaction: t,
  });
  return transaction;
}

/** Has this transaction already produced a receipt? Used by the API and tests. */
async function receiptFor(transactionId) {
  return Receipt.findOne({ where: { transaction_id: transactionId } });
}

module.exports = {
  applySettlement,
  OUTCOME,
  openUnapplied,
  moveToUnderReview,
  receiptFor,
  isDoublePaymentViolation,
  DOUBLE_PAYMENT_INDEX,
};
