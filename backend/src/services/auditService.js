'use strict';

const { AuditLog } = require('../models');
const { getCorrelationId } = require('../config/logger');

/**
 * Append only audit trail (§7.12).
 *
 * This is a financial system, so the audit log is not optional: every
 * transaction state change, fee item edit, unapplied payment resolution, and
 * admin login lands here. The database rejects UPDATE and DELETE on this table
 * outright, so an entry written is an entry kept.
 *
 * Writes take the caller's database transaction so the audit entry commits with
 * the change it describes, never separately.
 */

const ACTOR = Object.freeze({ STUDENT: 'student', ADMIN: 'admin', SYSTEM: 'system' });

const ACTION = Object.freeze({
  // transactions
  TRANSACTION_INITIATED: 'transaction.initiated',
  TRANSACTION_SETTLED: 'transaction.settled',
  TRANSACTION_UNDER_REVIEW: 'transaction.under_review',
  TRANSACTION_EXPIRED: 'transaction.expired',
  TRANSACTION_FAILED: 'transaction.failed',
  // receipts
  RECEIPT_ISSUED: 'receipt.issued',
  // unapplied payments
  UNAPPLIED_OPENED: 'unapplied.opened',
  UNAPPLIED_RESOLVED: 'unapplied.resolved',
  UNAPPLIED_EXPIRED: 'unapplied.expired',
  // fee items
  FEE_ITEM_CREATED: 'fee_item.created',
  FEE_ITEM_UPDATED: 'fee_item.updated',
  FEE_ITEM_DEACTIVATED: 'fee_item.deactivated',
  // people
  ADMIN_LOGIN: 'admin.login',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ADMIN_CREATED: 'admin.created',
  STUDENT_ACTIVATED: 'student.activated',
  STUDENT_PASSWORD_RESET: 'student.password_reset',
  STUDENTS_IMPORTED: 'students.imported',
  // webhooks
  WEBHOOK_REJECTED: 'webhook.rejected',
});

/**
 * Fields that must never reach the audit log, even inside a before/after state.
 * The log is permanent, so anything sensitive written here is sensitive forever.
 */
const FORBIDDEN_KEYS = new Set([
  'password',
  'password_hash',
  'code_hash',
  'token_hash',
  'otp',
  'access_token',
  'refresh_token',
  'signature',
]);

function scrub(state) {
  if (!state || typeof state !== 'object') return state ?? null;
  const plain = typeof state.toJSON === 'function' ? state.toJSON() : state;
  const out = {};
  for (const [key, value] of Object.entries(plain)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/**
 * Record one auditable event.
 *
 * @param {Object} entry
 * @param {'student'|'admin'|'system'} entry.actorType
 * @param {number|null} [entry.actorId]
 * @param {string} entry.action
 * @param {string} entry.entityType
 * @param {string|number|null} [entry.entityId]
 * @param {object|null} [entry.before]
 * @param {object|null} [entry.after]
 * @param {string|null} [entry.ipAddress]
 * @param {import('sequelize').Transaction} [entry.transaction]
 */
async function record({
  actorType,
  actorId = null,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  ipAddress = null,
  transaction,
}) {
  return AuditLog.create(
    {
      actor_type: actorType,
      actor_id: actorId,
      action,
      entity_type: entityType,
      entity_id: entityId === null || entityId === undefined ? null : String(entityId),
      before_state: scrub(before),
      after_state: scrub(after),
      ip_address: ipAddress,
      correlation_id: getCorrelationId() || null,
      created_at: new Date(),
    },
    { transaction }
  );
}

/** Convenience wrapper for events the system raises with no human actor. */
const recordSystem = (entry) => record({ ...entry, actorType: ACTOR.SYSTEM });

module.exports = { record, recordSystem, ACTOR, ACTION, scrub };
