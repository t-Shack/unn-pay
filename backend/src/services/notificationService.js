'use strict';

const { Student, Transaction, FeeItem } = require('../models');
const emailProvider = require('../adapters/email');
const push = require('../adapters/push/fcm');
const { formatNaira, toKobo } = require('../lib/money');
const { DateTime } = require('luxon');
const { logger } = require('../config/logger');

/**
 * Outbox event handlers (§9.3).
 *
 * One handler per event type. Each is called by the worker, outside any database
 * transaction that touched a payment, and either succeeds or throws — a throw
 * becomes a retry with backoff, and after eight attempts the entry is dead and
 * appears on the admin dashboard.
 *
 * Handlers must be safe to run twice. At-least-once delivery is the guarantee
 * the outbox provides; a student receiving one duplicate email is a far better
 * failure than a student receiving none.
 */

const WAT = 'Africa/Lagos';
const watDate = (value) =>
  DateTime.fromJSDate(new Date(value)).setZone(WAT).toFormat('d LLLL yyyy');

async function paymentSuccessful(payload) {
  const student = await Student.findByPk(payload.student_id);
  if (!student) return { skipped: 'student_not_found' };

  const email = await emailProvider.get().sendPaymentSuccessful({
    email: student.email,
    full_name: student.full_name,
    receipt_number: payload.receipt_number,
    amount: payload.amount,
    fee_item_description: payload.fee_item_description,
    unn_reference: payload.unn_reference,
  });

  const pushResult = await push.sendToStudent(student.student_id, {
    title: 'Payment received',
    body: `Your payment of ${formatNaira(toKobo(payload.amount))} was received. Receipt ${
      payload.receipt_number
    } is ready.`,
    data: {
      type: 'payment_successful',
      unn_reference: payload.unn_reference,
      receipt_number: payload.receipt_number,
      transaction_id: payload.transaction_id,
    },
  });

  return { email, push: pushResult };
}

/**
 * The student gets the exact figures and an explicit deadline date; Bursary gets
 * an alert of its own (§10, steps 3 and 4).
 */
async function paymentUnapplied(payload) {
  const student = payload.student_id ? await Student.findByPk(payload.student_id) : null;

  const results = {};

  if (student) {
    results.student_email = await emailProvider.get().sendUnappliedPaymentAlert({
      email: student.email,
      full_name: student.full_name,
      reason: payload.reason,
      amount_received: payload.amount_received,
      amount_expected: payload.amount_expected,
      variance: payload.variance,
      deadline_at: payload.deadline_at,
      unn_reference: payload.unn_reference,
    });

    results.push = await push.sendToStudent(student.student_id, {
      title: 'Your payment needs attention',
      body: `We received ${formatNaira(
        toKobo(payload.amount_received)
      )} but could not apply it. Visit the Bursary before ${watDate(payload.deadline_at)}.`,
      data: {
        type: 'payment_unapplied',
        unapplied_id: payload.unapplied_id,
        reason: payload.reason,
        deadline_at: payload.deadline_at,
      },
    });
  }

  results.bursary_email = await emailProvider.get().sendBursaryAlert({
    unapplied_id: payload.unapplied_id,
    reason: payload.reason,
    amount_received: payload.amount_received,
    amount_expected: payload.amount_expected,
    variance: payload.variance,
    unn_reference: payload.unn_reference,
    student_name: student ? student.full_name : null,
    matric_number: student ? student.matric_number : null,
    deadline_at: payload.deadline_at,
  });

  return results;
}

async function unappliedResolved(payload) {
  if (!payload.student_id) return { skipped: 'no_student' };

  const applied = payload.receipt_number !== null && payload.receipt_number !== undefined;

  return {
    push: await push.sendToStudent(payload.student_id, {
      title: applied ? 'Your payment has been applied' : 'Your payment has been reviewed',
      body: applied
        ? `The Bursary applied your payment. Receipt ${payload.receipt_number} is now available.`
        : 'The Bursary has reviewed your payment. Contact them if you need more detail.',
      data: {
        type: 'unapplied_resolved',
        unapplied_id: payload.unapplied_id,
        resolution: payload.resolution,
        receipt_number: payload.receipt_number || '',
      },
    }),
  };
}

async function activationOtp(payload) {
  return emailProvider.get().sendActivationOtp(payload);
}

async function passwordResetOtp(payload) {
  return emailProvider.get().sendPasswordResetOtp(payload);
}

/**
 * Retry a virtual account mint that was queued because the bank was unreachable
 * when the student pressed Pay (§9.4). Told here rather than in the API so the
 * student's request never waits on a bank that is already failing.
 */
async function mintVirtualAccount(payload) {
  const bankAdapters = require('../adapters/bank');
  const transaction = await Transaction.findByPk(payload.transaction_id);

  if (!transaction) return { skipped: 'transaction_not_found' };
  if (transaction.virtual_account_number) return { skipped: 'already_minted' };
  if (transaction.status !== Transaction.STATUS.PENDING) {
    return { skipped: `status_${transaction.status}` };
  }
  if (transaction.expires_at <= new Date()) return { skipped: 'expired' };

  const adapter = bankAdapters.get(payload.adapter || transaction.adapter);
  const account = await adapter.mintVirtualAccount({
    reference: transaction.unn_reference,
    amountKobo: payload.amount_kobo,
    payerName: payload.payer_name,
    expiresAt: new Date(payload.expires_at),
  });

  await transaction.update({
    virtual_account_number: account.accountNumber,
    virtual_account_bank: account.bankName,
    virtual_account_reference: account.providerReference,
    virtual_account_channels: account.channels,
  });

  const feeItem = await FeeItem.findByPk(transaction.fee_item_id);

  await push.sendToStudent(transaction.student_id, {
    title: 'Your payment reference is ready',
    body: `Pay ${formatNaira(toKobo(transaction.expected_amount))} for ${
      feeItem ? feeItem.name : 'your fee'
    } to account ${account.accountNumber} (${account.bankName}).`,
    data: {
      type: 'virtual_account_ready',
      unn_reference: transaction.unn_reference,
      account_number: account.accountNumber,
    },
  });

  logger.info(
    { transaction_id: transaction.transaction_id },
    'queued virtual account mint completed'
  );

  return { minted: true, account_number: account.accountNumber };
}

/** event_type -> handler. The worker refuses to process an unknown type. */
const HANDLERS = {
  'payment.successful': paymentSuccessful,
  'payment.unapplied': paymentUnapplied,
  'unapplied.resolved': unappliedResolved,
  'email.activation_otp': activationOtp,
  'email.password_reset_otp': passwordResetOtp,
  'payment.mint_virtual_account': mintVirtualAccount,
};

async function dispatch(eventType, payload) {
  const handler = HANDLERS[eventType];
  if (!handler) throw new Error(`No handler registered for outbox event "${eventType}"`);
  return handler(payload);
}

module.exports = { dispatch, HANDLERS };
