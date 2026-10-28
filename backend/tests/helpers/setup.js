'use strict';

/**
 * Per-suite test bootstrap.
 *
 * Points the process at the PostgreSQL instance that globalSetup started, then
 * gives each suite a clean set of tables. The engine is real PostgreSQL, not
 * SQLite: the behaviour under test includes partial unique indexes and
 * SELECT ... FOR UPDATE, neither of which SQLite has (§14).
 */

const fs = require('fs');
const { STATE_FILE } = require('./pgState');

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = state.url;
process.env.DATABASE_SSL = 'false';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret-'.padEnd(48, 'x');
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-'.padEnd(48, 'y');
process.env.RECEIPT_SIGNING_SECRET =
  process.env.RECEIPT_SIGNING_SECRET || 'test-receipt-secret-'.padEnd(48, 'z');
process.env.BANK_WEBHOOK_SECRET = process.env.BANK_WEBHOOK_SECRET || 'test-webhook-secret-abcdef';
process.env.BANK_ADAPTER = process.env.BANK_ADAPTER || 'sandbox';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4000';
process.env.ADMIN_ORIGINS = process.env.ADMIN_ORIGINS || 'http://localhost:5173';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const db = require('../../src/models');

const TABLES = [
  'idempotency_keys',
  'audit_log',
  'outbox',
  'webhook_events',
  'refresh_tokens',
  'auth_tokens',
  'device_tokens',
  'unapplied_payments',
  'receipts',
  'transactions',
  'fee_items',
  'student_imports',
  'admin_users',
  'students',
  'sandbox_settlements',
  'sandbox_virtual_accounts',
  'receipt_sequences',
];

/**
 * Empty every table and reset identity sequences.
 *
 * audit_log has a trigger that rejects DELETE, so it is TRUNCATEd, which the
 * trigger does not intercept — deliberately, since the append only guarantee is
 * about the application never rewriting history, not about a test fixture being
 * unable to reset.
 */
async function resetDatabase() {
  await db.sequelize.query(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
  );
}

async function closeDatabase() {
  await db.sequelize.close();
}

module.exports = { db, resetDatabase, closeDatabase, TABLES };
