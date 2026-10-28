'use strict';

const { Op } = require('sequelize');
const {
  Transaction: TransactionModel,
  FeeItem,
  Student,
  UnappliedPayment,
  AdminUser,
  Receipt,
  Outbox,
  sequelize,
} = require('../../models');
const { toKobo, koboToDecimalString, formatNaira } = require('../../lib/money');
const audit = require('../../services/auditService');
const outboxService = require('../../services/outboxService');
const receiptService = require('../../services/receiptService');
const bankAdapters = require('../../adapters/bank');
const { hashSecret } = require('../../lib/hash');
const { NotFoundError, ConflictError, BadRequestError } = require('../../lib/errors');
const config = require('../../config');

/**
 * Bursary administration (§11.6).
 *
 * Everything here that changes state writes to the audit log with the acting
 * admin's id. This is a financial system: "who changed this, and when" must be
 * answerable for every row.
 */

// --- transactions -----------------------------------------------------------

/** Filterable, paginated transaction list. */
async function listTransactions({
  from,
  to,
  department,
  level,
  status,
  feeItemId,
  matricNumber,
  page = 1,
  pageSize = 25,
} = {}) {
  const where = {};
  if (status) where.status = status;
  if (feeItemId) where.fee_item_id = feeItemId;
  if (from || to) {
    where.created_at = {};
    if (from) where.created_at[Op.gte] = from;
    if (to) where.created_at[Op.lte] = to;
  }

  const studentWhere = {};
  if (department) studentWhere.department = department;
  if (level) studentWhere.level = level;
  if (matricNumber) studentWhere.matric_number = { [Op.iLike]: `%${matricNumber}%` };

  const { rows, count } = await TransactionModel.findAndCountAll({
    where,
    include: [
      {
        model: Student,
        as: 'student',
        required: Object.keys(studentWhere).length > 0,
        where: Object.keys(studentWhere).length > 0 ? studentWhere : undefined,
      },
      { model: FeeItem, as: 'fee_item' },
      { model: Receipt, as: 'receipt' },
    ],
    order: [['created_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
  });

  return {
    items: rows.map(serialiseAdminTransaction),
    pagination: {
      page,
      page_size: pageSize,
      total: count,
      total_pages: Math.max(1, Math.ceil(count / pageSize)),
    },
  };
}

/** Same filters, no pagination — for CSV and PDF export (§11.6). */
async function listTransactionsForExport(filters = {}) {
  const { items } = await listTransactions({ ...filters, page: 1, pageSize: 10000 });
  return items;
}

function serialiseAdminTransaction(row) {
  return {
    transaction_id: row.transaction_id,
    unn_reference: row.unn_reference,
    status: row.status,
    expected_amount: row.expected_amount,
    amount_paid: row.amount_paid,
    variance:
      row.amount_paid !== null
        ? koboToDecimalString(toKobo(row.amount_paid) - toKobo(row.expected_amount))
        : null,
    channel: row.channel,
    virtual_account_number: row.virtual_account_number,
    virtual_account_bank: row.virtual_account_bank,
    adapter: row.adapter,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
    student: row.student
      ? {
          student_id: row.student.student_id,
          matric_number: row.student.matric_number,
          full_name: row.student.full_name,
          department: row.student.department,
          level: row.student.level,
        }
      : null,
    fee_item: row.fee_item
      ? {
          fee_item_id: row.fee_item.fee_item_id,
          name: row.fee_item.name,
          category: row.fee_item.category,
          session: row.fee_item.session,
        }
      : null,
    receipt_number: row.receipt ? row.receipt.receipt_number : null,
  };
}

// --- unapplied payments (§10) ----------------------------------------------

async function listUnapplied({ status = 'open', page = 1, pageSize = 25 } = {}) {
  const where = status === 'all' ? {} : { status };

  const { rows, count } = await UnappliedPayment.findAndCountAll({
    where,
    include: [
      { model: Student, as: 'student' },
      { model: TransactionModel, as: 'transaction', include: [{ model: FeeItem, as: 'fee_item' }] },
      { model: AdminUser, as: 'resolved_by' },
    ],
    order: [['created_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
  });

  return {
    items: rows.map(serialiseUnapplied),
    pagination: {
      page,
      page_size: pageSize,
      total: count,
      total_pages: Math.max(1, Math.ceil(count / pageSize)),
    },
  };
}

function serialiseUnapplied(row) {
  return {
    unapplied_id: row.unapplied_id,
    unn_reference: row.unn_reference,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    amount_received: row.amount_received,
    amount_received_formatted: formatNaira(toKobo(row.amount_received)),
    amount_expected: row.amount_expected,
    variance: row.variance,
    variance_formatted: row.variance !== null ? formatNaira(toKobo(row.variance)) : null,
    payer_details: row.payer_details,
    resolution_note: row.resolution_note,
    deadline_at: row.deadline_at,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    days_remaining:
      row.status === 'open'
        ? Math.ceil((new Date(row.deadline_at) - Date.now()) / (24 * 60 * 60 * 1000))
        : null,
    student: row.student
      ? {
          student_id: row.student.student_id,
          matric_number: row.student.matric_number,
          full_name: row.student.full_name,
          email: row.student.email,
          department: row.student.department,
        }
      : null,
    transaction: row.transaction
      ? {
          transaction_id: row.transaction.transaction_id,
          unn_reference: row.transaction.unn_reference,
          status: row.transaction.status,
          expected_amount: row.transaction.expected_amount,
          fee_item: row.transaction.fee_item
            ? { fee_item_id: row.transaction.fee_item.fee_item_id, name: row.transaction.fee_item.name }
            : null,
        }
      : null,
    resolved_by: row.resolved_by ? { admin_id: row.resolved_by.admin_id, full_name: row.resolved_by.full_name } : null,
  };
}

/**
 * Resolve an unapplied payment (§10). Bursary only, always with a note, always
 * audited. Applying to a fee item settles the transaction and issues the receipt
 * that was withheld when the money first arrived.
 */
async function resolveUnapplied({ unappliedId, adminId, resolution, note, targetFeeItemId, ipAddress }) {
  if (!note || String(note).trim().length < 5) {
    throw new BadRequestError('A resolution note is required', 'resolution_note_required');
  }

  return sequelize.transaction(async (t) => {
    const unapplied = await UnappliedPayment.findByPk(unappliedId, {
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!unapplied) throw new NotFoundError('Unapplied payment not found', 'unapplied_not_found');
    if (unapplied.status === 'resolved') {
      throw new ConflictError('This item has already been resolved', 'already_resolved');
    }

    const before = unapplied.toJSON();
    let receipt = null;
    let settledTransaction = null;

    if (
      resolution === UnappliedPayment.RESOLUTIONS.APPLIED_TO_INTENDED_FEE ||
      resolution === UnappliedPayment.RESOLUTIONS.APPLIED_TO_OTHER_FEE
    ) {
      settledTransaction = await applyToFeeItem(
        { unapplied, resolution, targetFeeItemId, adminId, ipAddress },
        t
      );
      receipt = await Receipt.findOne({
        where: { transaction_id: settledTransaction.transaction_id },
        transaction: t,
      });
    }

    await unapplied.update(
      {
        status: 'resolved',
        resolution,
        resolution_note: String(note).trim(),
        resolved_by_admin_id: adminId,
        resolved_at: new Date(),
      },
      { transaction: t }
    );

    await audit.record({
      actorType: audit.ACTOR.ADMIN,
      actorId: adminId,
      action: audit.ACTION.UNAPPLIED_RESOLVED,
      entityType: 'unapplied_payment',
      entityId: unapplied.unapplied_id,
      before,
      after: unapplied.toJSON(),
      ipAddress,
      transaction: t,
    });

    await outboxService.enqueue(
      'unapplied.resolved',
      {
        unapplied_id: unapplied.unapplied_id,
        student_id: unapplied.student_id,
        resolution,
        note: String(note).trim(),
        transaction_id: settledTransaction ? settledTransaction.transaction_id : null,
        receipt_number: receipt ? receipt.receipt_number : null,
      },
      { transaction: t }
    );

    return { unapplied, receipt, transaction: settledTransaction };
  });
}

/**
 * Settle a transaction as the outcome of a Bursary decision.
 *
 * The partial unique index still applies: if the student has since paid that fee
 * item successfully by another route, this fails loudly rather than creating a
 * second successful payment for one fee.
 */
async function applyToFeeItem({ unapplied, resolution, targetFeeItemId, adminId, ipAddress }, t) {
  let transaction = unapplied.transaction_id
    ? await TransactionModel.findByPk(unapplied.transaction_id, { lock: t.LOCK.UPDATE, transaction: t })
    : null;

  if (resolution === UnappliedPayment.RESOLUTIONS.APPLIED_TO_OTHER_FEE) {
    if (!targetFeeItemId) {
      throw new BadRequestError(
        'A target fee item is required to apply this payment elsewhere',
        'target_fee_item_required'
      );
    }
    if (!unapplied.student_id) {
      throw new BadRequestError(
        'This payment is not linked to a student, so it cannot be applied to a fee item. Record it as a refund instead.',
        'unapplied_has_no_student'
      );
    }

    const feeItem = await FeeItem.findByPk(targetFeeItemId, { transaction: t });
    if (!feeItem) throw new NotFoundError('Target fee item not found', 'fee_item_not_found');

    // A fresh transaction is created for the fee the money is being moved onto,
    // so the original attempt's history stays intact and auditable.
    transaction = await TransactionModel.create(
      {
        unn_reference: await require('../../services/paymentService').mintUniqueReference(
          feeItem.session,
          { transaction: t }
        ),
        student_id: unapplied.student_id,
        fee_item_id: feeItem.fee_item_id,
        expected_amount: feeItem.amount,
        adapter: 'manual',
        status: TransactionModel.STATUS.PENDING,
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
      },
      { transaction: t }
    );
  }

  if (!transaction) {
    throw new BadRequestError(
      'This payment is not linked to a transaction, so it cannot be applied to the intended fee',
      'unapplied_has_no_transaction'
    );
  }

  if (transaction.status === TransactionModel.STATUS.SUCCESSFUL) {
    throw new ConflictError('That fee is already settled', 'already_settled');
  }

  const feeItem = await FeeItem.findByPk(transaction.fee_item_id, { transaction: t });
  const before = transaction.toJSON();

  await transaction.update(
    {
      status: TransactionModel.STATUS.SUCCESSFUL,
      amount_paid: unapplied.amount_received,
      channel: (unapplied.payer_details && unapplied.payer_details.channel) || transaction.channel,
      paid_at: transaction.paid_at || new Date(),
    },
    { transaction: t }
  );

  const receipt = await receiptService.issueReceipt(transaction, {
    feeItem,
    session: feeItem ? feeItem.session : null,
    transaction: t,
  });

  await audit.record({
    actorType: audit.ACTOR.ADMIN,
    actorId: adminId,
    action: audit.ACTION.TRANSACTION_SETTLED,
    entityType: 'transaction',
    entityId: transaction.transaction_id,
    before,
    after: transaction.toJSON(),
    ipAddress,
    transaction: t,
  });

  // Every receipt that exists must be traceable to the decision that produced
  // it, whether that decision was a settlement or a Bursary officer's judgement.
  await audit.record({
    actorType: audit.ACTOR.ADMIN,
    actorId: adminId,
    action: audit.ACTION.RECEIPT_ISSUED,
    entityType: 'receipt',
    entityId: receipt.receipt_id,
    after: receipt.toJSON(),
    ipAddress,
    transaction: t,
  });

  return transaction;
}

// --- fee items --------------------------------------------------------------

async function listFeeItems({ session, includeInactive = false } = {}) {
  const where = {};
  if (session) where.session = session;
  if (!includeInactive) where.is_active = true;
  return FeeItem.findAll({ where, order: [['session', 'DESC'], ['category', 'ASC'], ['name', 'ASC']] });
}

async function createFeeItem({ data, adminId, ipAddress }) {
  const feeItem = await sequelize.transaction(async (t) => {
    const created = await FeeItem.create(
      {
        name: data.name,
        category: data.category,
        amount: koboToDecimalString(toKobo(data.amount)),
        department: data.department ?? null,
        level: data.level ?? null,
        session: data.session,
        is_active: data.is_active ?? true,
      },
      { transaction: t }
    );
    await audit.record({
      actorType: audit.ACTOR.ADMIN,
      actorId: adminId,
      action: audit.ACTION.FEE_ITEM_CREATED,
      entityType: 'fee_item',
      entityId: created.fee_item_id,
      after: created.toJSON(),
      ipAddress,
      transaction: t,
    });
    return created;
  });
  return feeItem;
}

async function updateFeeItem({ feeItemId, data, adminId, ipAddress }) {
  return sequelize.transaction(async (t) => {
    const feeItem = await FeeItem.findByPk(feeItemId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!feeItem) throw new NotFoundError('Fee item not found', 'fee_item_not_found');

    const before = feeItem.toJSON();
    const patch = {};
    for (const key of ['name', 'category', 'department', 'level', 'session', 'is_active']) {
      if (data[key] !== undefined) patch[key] = data[key];
    }
    // Editing a price never alters an already issued reference: transactions
    // snapshot expected_amount at mint time (§7.4).
    if (data.amount !== undefined) patch.amount = koboToDecimalString(toKobo(data.amount));

    await feeItem.update(patch, { transaction: t });

    await audit.record({
      actorType: audit.ACTOR.ADMIN,
      actorId: adminId,
      action: audit.ACTION.FEE_ITEM_UPDATED,
      entityType: 'fee_item',
      entityId: feeItem.fee_item_id,
      before,
      after: feeItem.toJSON(),
      ipAddress,
      transaction: t,
    });

    return feeItem;
  });
}

/** DELETE is soft only (§11.6): a fee with payments against it is never removed. */
async function deactivateFeeItem({ feeItemId, adminId, ipAddress }) {
  return sequelize.transaction(async (t) => {
    const feeItem = await FeeItem.findByPk(feeItemId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!feeItem) throw new NotFoundError('Fee item not found', 'fee_item_not_found');

    const before = feeItem.toJSON();
    await feeItem.update({ is_active: false }, { transaction: t });

    await audit.record({
      actorType: audit.ACTOR.ADMIN,
      actorId: adminId,
      action: audit.ACTION.FEE_ITEM_DEACTIVATED,
      entityType: 'fee_item',
      entityId: feeItem.fee_item_id,
      before,
      after: feeItem.toJSON(),
      ipAddress,
      transaction: t,
    });

    return feeItem;
  });
}

// --- staff ------------------------------------------------------------------

/** Super Admin only. There is no public admin registration endpoint, ever. */
async function createStaff({ data, adminId, ipAddress }) {
  const existing = await AdminUser.findOne({
    where: { [Op.or]: [{ email: data.email.toLowerCase() }, { staff_id: data.staff_id }] },
  });
  if (existing) {
    throw new ConflictError('A staff account with that email or staff id already exists', 'staff_exists');
  }

  const created = await sequelize.transaction(async (t) => {
    const admin = await AdminUser.create(
      {
        staff_id: data.staff_id,
        full_name: data.full_name,
        email: data.email.toLowerCase(),
        password_hash: await hashSecret(data.password),
        role: data.role,
        is_active: true,
      },
      { transaction: t }
    );
    await audit.record({
      actorType: audit.ACTOR.ADMIN,
      actorId: adminId,
      action: audit.ACTION.ADMIN_CREATED,
      entityType: 'admin_user',
      entityId: admin.admin_id,
      after: admin.toPublicJSON(),
      ipAddress,
      transaction: t,
    });
    return admin;
  });

  return created.toPublicJSON();
}

// --- operational health panel (§9.6) ---------------------------------------

async function dashboardHealth() {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

  const [stuckPending, openUnapplied, outboxStats, overdueUnapplied] = await Promise.all([
    TransactionModel.count({
      where: {
        status: TransactionModel.STATUS.PENDING,
        created_at: { [Op.lt]: thirtyMinutesAgo },
        expires_at: { [Op.gt]: new Date() },
      },
    }),
    UnappliedPayment.count({ where: { status: 'open' } }),
    outboxService.stats(),
    UnappliedPayment.count({
      where: { status: 'open', deadline_at: { [Op.lt]: new Date() } },
    }),
  ]);

  const deadEntries = await Outbox.findAll({
    where: { status: 'dead' },
    order: [['updated_at', 'DESC']],
    limit: 20,
  });

  const adapter = bankAdapters.getDefault();

  return {
    pending_older_than_30_minutes: stuckPending,
    open_unapplied_payments: openUnapplied,
    unapplied_past_deadline: overdueUnapplied,
    outbox: outboxStats,
    dead_outbox_entries: deadEntries.map((entry) => ({
      outbox_id: entry.outbox_id,
      event_type: entry.event_type,
      attempt_count: entry.attempt_count,
      last_error: entry.last_error,
      updated_at: entry.updated_at,
    })),
    circuit_breaker: adapter.circuitSnapshot ? adapter.circuitSnapshot() : null,
    bank_adapter: { name: adapter.name, display_name: adapter.displayName },
    configuration: {
      payment_reference_ttl_hours: config.PAYMENT_REFERENCE_TTL_HOURS,
      unapplied_resolution_days: config.UNAPPLIED_RESOLUTION_DAYS,
    },
    generated_at: new Date().toISOString(),
  };
}

/** Headline figures for the dashboard landing page. */
async function summary({ session } = {}) {
  const feeWhere = session ? { session } : {};
  const feeItems = await FeeItem.findAll({ where: feeWhere, attributes: ['fee_item_id'] });
  const feeItemIds = feeItems.map((f) => f.fee_item_id);

  const where = feeItemIds.length > 0 ? { fee_item_id: { [Op.in]: feeItemIds } } : {};

  const rows = await TransactionModel.findAll({
    where,
    attributes: [
      'status',
      [sequelize.fn('COUNT', sequelize.col('transaction_id')), 'count'],
      [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_paid')), 0), 'total_paid'],
    ],
    group: ['status'],
    raw: true,
  });

  const byStatus = {};
  let collectedKobo = 0;
  let successfulCount = 0;

  for (const row of rows) {
    byStatus[row.status] = Number(row.count);
    if (row.status === 'Successful') {
      collectedKobo = toKobo(row.total_paid);
      successfulCount = Number(row.count);
    }
  }

  return {
    total_collected: koboToDecimalString(collectedKobo),
    total_collected_formatted: formatNaira(collectedKobo),
    successful_payments: successfulCount,
    by_status: byStatus,
    students: {
      total: await Student.count(),
      active: await Student.count({ where: { status: 'active' } }),
      imported: await Student.count({ where: { status: 'imported' } }),
    },
  };
}

module.exports = {
  listTransactions,
  listTransactionsForExport,
  listUnapplied,
  resolveUnapplied,
  listFeeItems,
  createFeeItem,
  updateFeeItem,
  deactivateFeeItem,
  createStaff,
  dashboardHealth,
  summary,
  serialiseAdminTransaction,
  serialiseUnapplied,
};
