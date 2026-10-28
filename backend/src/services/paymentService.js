'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const {
  Transaction: TransactionModel,
  FeeItem,
  Student,
  Receipt,
  sequelize,
} = require('../models');
const bankAdapters = require('../adapters/bank');
const { generateReference, isValidReference, normaliseReference } = require('../lib/reference');
const { toKobo, koboToDecimalString, formatNaira } = require('../lib/money');
const {
  NotFoundError,
  ConflictError,
  BadRequestError,
  BankUnavailableError,
} = require('../lib/errors');
const audit = require('./auditService');
const outboxService = require('./outboxService');
const { logger } = require('../config/logger');
const config = require('../config');

/**
 * Payment initiation and lookup (§11.3).
 *
 * The client sends a fee item id and nothing else. The server resolves the
 * amount from fee_items, snapshots it onto the transaction, mints the UNN
 * Payment Reference, and asks the bank for a virtual account. An amount supplied
 * by a client is never trusted anywhere in this codebase.
 */

/** Collisions are handled by the unique constraint, not by hoping. */
const REFERENCE_MINT_ATTEMPTS = 6;

/**
 * Mint a reference that is unique in the database.
 *
 * Seven random digits is roughly ten million values per session-month prefix, so
 * with tens of thousands of references in a registration week a collision is
 * not an abstract possibility — it is expected occasionally. The unique
 * constraint catches it and this retries.
 */
async function mintUniqueReference(session, { transaction } = {}) {
  for (let attempt = 1; attempt <= REFERENCE_MINT_ATTEMPTS; attempt += 1) {
    const reference = generateReference({ session });
    const clash = await TransactionModel.findOne({
      where: { unn_reference: reference },
      attributes: ['transaction_id'],
      transaction,
    });
    if (!clash) return reference;
    logger.warn({ attempt, session }, 'payment reference collision; retrying');
  }
  throw new ConflictError(
    'Could not mint a unique payment reference; please try again',
    'reference_mint_failed'
  );
}

/**
 * Is this fee item applicable to this student? (§11.2)
 * Active, same session, and department/level either matching or unrestricted.
 */
function isApplicable(feeItem, student) {
  if (!feeItem.is_active) return false;
  if (feeItem.department !== null && feeItem.department !== student.department) return false;
  if (feeItem.level !== null && feeItem.level !== student.level) return false;
  return true;
}

/**
 * Start a payment.
 *
 * @param {Object} params
 * @param {object} params.student
 * @param {number} params.feeItemId
 * @param {string} [params.ipAddress]
 * @returns {Promise<{transaction: object, feeItem: object, virtualAccountPending: boolean}>}
 */
async function initiatePayment({ student, feeItemId, ipAddress = null }) {
  const feeItem = await FeeItem.findByPk(feeItemId);
  if (!feeItem) throw new NotFoundError('Fee item not found', 'fee_item_not_found');
  if (!isApplicable(feeItem, student)) {
    throw new BadRequestError(
      'This fee item does not apply to your department, level or session',
      'fee_item_not_applicable'
    );
  }

  // The application level double payment check. It exists to return a clean
  // error rather than a raw constraint violation; the partial unique index in
  // the database is the actual guarantee (§7.4).
  const alreadyPaid = await TransactionModel.findOne({
    where: {
      student_id: student.student_id,
      fee_item_id: feeItem.fee_item_id,
      status: TransactionModel.STATUS.SUCCESSFUL,
    },
  });
  if (alreadyPaid) {
    throw new ConflictError('You have already paid this fee', 'fee_already_paid', {
      unn_reference: alreadyPaid.unn_reference,
    });
  }

  const underReview = await TransactionModel.findOne({
    where: {
      student_id: student.student_id,
      fee_item_id: feeItem.fee_item_id,
      status: TransactionModel.STATUS.UNDER_REVIEW,
    },
  });
  if (underReview) {
    throw new ConflictError(
      'A payment for this fee is under review by the Bursary. Please visit the Bursary before paying again.',
      'fee_under_review',
      { unn_reference: underReview.unn_reference }
    );
  }

  const expectedKobo = toKobo(feeItem.amount);
  const expiresAt = new Date(Date.now() + config.PAYMENT_REFERENCE_TTL_HOURS * 60 * 60 * 1000);
  const adapter = bankAdapters.getDefault();

  // The reference and the transaction row are created first, and committed,
  // before the bank is called. If the bank call then fails we hold a durable
  // record of the attempt rather than losing it, and the account can be minted
  // later by the worker (§9.4).
  const transaction = await sequelize.transaction(async (t) => {
    const reference = await mintUniqueReference(feeItem.session, { transaction: t });

    const created = await TransactionModel.create(
      {
        unn_reference: reference,
        student_id: student.student_id,
        fee_item_id: feeItem.fee_item_id,
        expected_amount: koboToDecimalString(expectedKobo),
        adapter: adapter.name,
        status: TransactionModel.STATUS.PENDING,
        expires_at: expiresAt,
      },
      { transaction: t }
    );

    await audit.record({
      actorType: audit.ACTOR.STUDENT,
      actorId: student.student_id,
      action: audit.ACTION.TRANSACTION_INITIATED,
      entityType: 'transaction',
      entityId: created.transaction_id,
      after: created.toJSON(),
      ipAddress,
      transaction: t,
    });

    return created;
  });

  // --- mint the virtual account -------------------------------------------
  try {
    const account = await adapter.mintVirtualAccount({
      reference: transaction.unn_reference,
      amountKobo: expectedKobo,
      payerName: student.full_name,
      expiresAt,
    });

    assertMintShape(account);

    await transaction.update({
      virtual_account_number: account.accountNumber,
      virtual_account_bank: account.bankName,
      virtual_account_reference: account.providerReference,
      virtual_account_channels: account.channels,
    });

    return {
      transaction,
      feeItem,
      channels: account.channels,
      virtualAccountPending: false,
    };
  } catch (error) {
    if (error instanceof BankUnavailableError) {
      // Queued, not rejected (§9.4). The student is told their reference is
      // being generated and will be notified; the worker retries the mint.
      await outboxService.enqueue('payment.mint_virtual_account', {
        transaction_id: transaction.transaction_id,
        unn_reference: transaction.unn_reference,
        student_id: student.student_id,
        amount_kobo: expectedKobo,
        payer_name: student.full_name,
        expires_at: expiresAt.toISOString(),
        adapter: adapter.name,
      });
      logger.warn(
        { transaction_id: transaction.transaction_id, err: error.message },
        'bank unavailable at mint time; queued for the worker'
      );
      return { transaction, feeItem, channels: [], virtualAccountPending: true };
    }
    throw error;
  }
}

/** An adapter that returns the wrong shape is a bug in the adapter, caught here. */
function assertMintShape(account) {
  const ok =
    account &&
    typeof account.accountNumber === 'string' &&
    account.accountNumber.length > 0 &&
    typeof account.bankName === 'string' &&
    typeof account.providerReference === 'string' &&
    account.providerReference.length > 0 &&
    Array.isArray(account.channels);
  if (!ok) {
    throw new BankUnavailableError('The bank returned an unusable account', {
      code: 'bank_malformed_response',
    });
  }
}

/** Poll a payment's status. Scoped to the owning student; never cross student. */
async function getPaymentForStudent(reference, studentId) {
  const normalised = normaliseReference(reference);
  if (!isValidReference(normalised)) {
    throw new BadRequestError('That payment reference is not valid', 'invalid_reference');
  }

  const transaction = await TransactionModel.findOne({
    where: { unn_reference: normalised },
    include: [
      { model: FeeItem, as: 'fee_item' },
      { model: Receipt, as: 'receipt' },
    ],
  });

  // Same error for "does not exist" and "belongs to someone else", so the API
  // cannot be used to discover which references exist (§14 security tests).
  if (!transaction || transaction.student_id !== studentId) {
    throw new NotFoundError('Payment not found', 'payment_not_found');
  }
  return transaction;
}

/** Paginated payment history for a student. */
async function listPaymentsForStudent(studentId, { page = 1, pageSize = 20, status } = {}) {
  const where = { student_id: studentId };
  if (status) where.status = status;

  const { rows, count } = await TransactionModel.findAndCountAll({
    where,
    include: [
      { model: FeeItem, as: 'fee_item' },
      { model: Receipt, as: 'receipt' },
    ],
    order: [['created_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    items: rows.map(serialiseTransaction),
    pagination: {
      page,
      page_size: pageSize,
      total: count,
      total_pages: Math.max(1, Math.ceil(count / pageSize)),
    },
  };
}

/**
 * Fee list for a student, each item flagged paid, pending, under review or
 * outstanding, plus the total still outstanding (§11.2).
 */
async function listFeesForStudent(student, { session } = {}) {
  const where = {
    is_active: true,
    [Op.and]: [
      { [Op.or]: [{ department: null }, { department: student.department }] },
      { [Op.or]: [{ level: null }, { level: student.level }] },
    ],
  };
  if (session) where.session = session;

  const feeItems = await FeeItem.findAll({ where, order: [['category', 'ASC'], ['name', 'ASC']] });

  const transactions = await TransactionModel.findAll({
    where: {
      student_id: student.student_id,
      fee_item_id: { [Op.in]: feeItems.map((f) => f.fee_item_id) },
      status: {
        [Op.in]: [
          TransactionModel.STATUS.SUCCESSFUL,
          TransactionModel.STATUS.PENDING,
          TransactionModel.STATUS.UNDER_REVIEW,
        ],
      },
    },
    order: [['created_at', 'DESC']],
  });

  // Most significant status wins: paid beats under review beats pending.
  const byFeeItem = new Map();
  const rank = { Successful: 3, UnderReview: 2, Pending: 1 };
  for (const row of transactions) {
    const current = byFeeItem.get(row.fee_item_id);
    if (!current || rank[row.status] > rank[current.status]) byFeeItem.set(row.fee_item_id, row);
  }

  let outstandingKobo = 0;
  const items = feeItems.map((feeItem) => {
    const match = byFeeItem.get(feeItem.fee_item_id);
    const amountKobo = toKobo(feeItem.amount);

    let paymentStatus = 'outstanding';
    if (match) {
      if (match.status === TransactionModel.STATUS.SUCCESSFUL) paymentStatus = 'paid';
      else if (match.status === TransactionModel.STATUS.UNDER_REVIEW) paymentStatus = 'under_review';
      else if (match.expires_at > new Date()) paymentStatus = 'pending';
    }

    if (paymentStatus !== 'paid') outstandingKobo += amountKobo;

    return {
      fee_item_id: feeItem.fee_item_id,
      name: feeItem.name,
      category: feeItem.category,
      amount: feeItem.amount,
      amount_formatted: formatNaira(amountKobo),
      session: feeItem.session,
      department: feeItem.department,
      level: feeItem.level,
      payment_status: paymentStatus,
      unn_reference: match ? match.unn_reference : null,
      paid_at: match && match.status === 'Successful' ? match.paid_at : null,
    };
  });

  return {
    items,
    total_outstanding: koboToDecimalString(outstandingKobo),
    total_outstanding_formatted: formatNaira(outstandingKobo),
  };
}

/** Wire shape for a transaction. Deliberately explicit: no model leakage. */
function serialiseTransaction(transaction, { channels } = {}) {
  const expectedKobo = toKobo(transaction.expected_amount);
  return {
    unn_reference: transaction.unn_reference,
    status: transaction.status,
    expected_amount: transaction.expected_amount,
    expected_amount_formatted: formatNaira(expectedKobo),
    amount_paid: transaction.amount_paid,
    amount_paid_formatted: transaction.amount_paid
      ? formatNaira(toKobo(transaction.amount_paid))
      : null,
    virtual_account_number: transaction.virtual_account_number,
    virtual_account_bank: transaction.virtual_account_bank,
    virtual_account_pending: !transaction.virtual_account_number,
    channel: transaction.channel,
    channels: channels || transaction.virtual_account_channels || undefined,
    expires_at: transaction.expires_at,
    paid_at: transaction.paid_at,
    created_at: transaction.created_at,
    fee_item: transaction.fee_item
      ? {
          fee_item_id: transaction.fee_item.fee_item_id,
          name: transaction.fee_item.name,
          category: transaction.fee_item.category,
          session: transaction.fee_item.session,
        }
      : undefined,
    receipt: transaction.receipt
      ? {
          receipt_number: transaction.receipt.receipt_number,
          verification_code: transaction.receipt.verification_code,
          issued_at: transaction.receipt.issued_at,
        }
      : null,
  };
}

module.exports = {
  initiatePayment,
  getPaymentForStudent,
  listPaymentsForStudent,
  listFeesForStudent,
  serialiseTransaction,
  mintUniqueReference,
  isApplicable,
  UniqueConstraintError,
};
