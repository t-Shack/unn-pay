'use strict';

/**
 * Initial UNN Pay schema (spec §7).
 *
 * Conventions applied throughout:
 *  - money is NUMERIC(12,2); never a float
 *  - every datetime is TIMESTAMPTZ; the database runs in UTC
 *  - structured columns are JSONB, not JSON
 *  - every table carries created_at and updated_at
 */

const { DataTypes } = require('sequelize');

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize_NOW() },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize_NOW() },
};

// Defined as a function so the literal is created fresh per column.
function Sequelize_NOW() {
  const { Sequelize } = require('sequelize');
  return Sequelize.literal('CURRENT_TIMESTAMP');
}

const money = (options = {}) => ({ type: DataTypes.DECIMAL(12, 2), ...options });

module.exports = {
  async up(queryInterface) {
    const t = await queryInterface.sequelize.transaction();
    try {
      const opts = { transaction: t };

      // --- students (§7.1) -------------------------------------------------
      await queryInterface.createTable(
        'students',
        {
          student_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          matric_number: { type: DataTypes.STRING(20), allowNull: false, unique: true },
          full_name: { type: DataTypes.STRING(100), allowNull: false },
          email: { type: DataTypes.STRING(100), allowNull: false, unique: true },
          phone: { type: DataTypes.STRING(20), allowNull: true },
          // NULL until the student activates their account.
          password_hash: { type: DataTypes.STRING(255), allowNull: true },
          department: { type: DataTypes.STRING(100), allowNull: false },
          level: { type: DataTypes.STRING(10), allowNull: false },
          status: {
            type: DataTypes.ENUM('imported', 'active', 'suspended'),
            allowNull: false,
            defaultValue: 'imported',
          },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addIndex('students', ['department', 'level'], {
        name: 'students_department_level_idx',
        ...opts,
      });
      await queryInterface.addIndex('students', ['status'], {
        name: 'students_status_idx',
        ...opts,
      });

      // --- admin_users (§7.7) ----------------------------------------------
      await queryInterface.createTable(
        'admin_users',
        {
          admin_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          staff_id: { type: DataTypes.STRING(50), allowNull: false, unique: true },
          full_name: { type: DataTypes.STRING(100), allowNull: false },
          email: { type: DataTypes.STRING(100), allowNull: false, unique: true },
          password_hash: { type: DataTypes.STRING(255), allowNull: false },
          role: {
            type: DataTypes.ENUM('Bursary Staff', 'Super Admin'),
            allowNull: false,
            defaultValue: 'Bursary Staff',
          },
          is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
          last_login_at: { type: DataTypes.DATE, allowNull: true },
          ...timestamps,
        },
        opts
      );

      // --- student_imports (§7.2) ------------------------------------------
      await queryInterface.createTable(
        'student_imports',
        {
          import_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          admin_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'admin_users', key: 'admin_id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          filename: { type: DataTypes.STRING(255), allowNull: false },
          session: { type: DataTypes.STRING(9), allowNull: false },
          row_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          success_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          failure_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          status: {
            type: DataTypes.ENUM('previewed', 'committed', 'rejected'),
            allowNull: false,
            defaultValue: 'previewed',
          },
          error_report: { type: DataTypes.JSONB, allowNull: true },
          ...timestamps,
        },
        opts
      );

      // --- fee_items (§7.3) -------------------------------------------------
      await queryInterface.createTable(
        'fee_items',
        {
          fee_item_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          name: { type: DataTypes.STRING(150), allowNull: false },
          category: {
            type: DataTypes.ENUM('Tuition', 'Acceptance', 'Departmental', 'Hostel', 'Other'),
            allowNull: false,
          },
          // Authoritative. Never accepted from a client.
          amount: money({ allowNull: false }),
          // NULL means "applies to all departments" / "all levels".
          department: { type: DataTypes.STRING(100), allowNull: true },
          level: { type: DataTypes.STRING(10), allowNull: true },
          session: { type: DataTypes.STRING(9), allowNull: false },
          is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addIndex('fee_items', ['session', 'is_active'], {
        name: 'fee_items_session_active_idx',
        ...opts,
      });

      // --- transactions (§7.4) ---------------------------------------------
      await queryInterface.createTable(
        'transactions',
        {
          transaction_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          unn_reference: { type: DataTypes.STRING(20), allowNull: false, unique: true },
          student_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'students', key: 'student_id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          fee_item_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'fee_items', key: 'fee_item_id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          // Snapshot of fee_items.amount at mint time: a mid session price change
          // must not alter an amount already quoted to a student.
          expected_amount: money({ allowNull: false }),
          amount_paid: money({ allowNull: true }),
          virtual_account_number: { type: DataTypes.STRING(20), allowNull: true },
          virtual_account_bank: { type: DataTypes.STRING(100), allowNull: true },
          // The bank's id for the *settlement*. Distinct from the virtual
          // account's own reference below, which is minted earlier and is what
          // we quote back to the bank to release the account on expiry.
          provider_reference: { type: DataTypes.STRING(100), allowNull: true },
          virtual_account_reference: { type: DataTypes.STRING(100), allowNull: true },
          virtual_account_released_at: { type: DataTypes.DATE, allowNull: true },
          // Which adapter minted this. Kept per transaction, not global, so a
          // future router can pick a bank at mint time (§5.1).
          adapter: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'sandbox' },
          channel: { type: DataTypes.STRING(20), allowNull: true },
          status: {
            type: DataTypes.ENUM('Pending', 'Successful', 'Failed', 'Expired', 'UnderReview'),
            allowNull: false,
            defaultValue: 'Pending',
          },
          expires_at: { type: DataTypes.DATE, allowNull: false },
          paid_at: { type: DataTypes.DATE, allowNull: true },
          ...timestamps,
        },
        opts
      );

      // The double payment guard. This, not the application check, is the real
      // guarantee: concurrent requests defeat an application check every time.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uniq_successful_payment_per_fee_item
           ON transactions (student_id, fee_item_id)
           WHERE status = 'Successful'`,
        opts
      );
      // A provider reference identifies one settlement; two transactions must
      // never claim the same one.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uniq_transaction_provider_reference
           ON transactions (provider_reference)
           WHERE provider_reference IS NOT NULL`,
        opts
      );
      await queryInterface.addIndex('transactions', ['student_id', 'created_at'], {
        name: 'transactions_student_created_idx',
        ...opts,
      });
      // Drives the reconciliation sweep's "pending and stale" query (§9.2).
      await queryInterface.addIndex('transactions', ['status', 'created_at'], {
        name: 'transactions_status_created_idx',
        ...opts,
      });
      await queryInterface.addIndex('transactions', ['status', 'expires_at'], {
        name: 'transactions_status_expires_idx',
        ...opts,
      });

      // --- receipts (§7.5) --------------------------------------------------
      await queryInterface.createTable(
        'receipts',
        {
          receipt_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          transaction_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            unique: true,
            references: { model: 'transactions', key: 'transaction_id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          receipt_number: { type: DataTypes.STRING(30), allowNull: false, unique: true },
          verification_code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
          signature: { type: DataTypes.STRING(128), allowNull: false },
          amount: money({ allowNull: false }),
          fee_item_description: { type: DataTypes.STRING(255), allowNull: false },
          issued_at: { type: DataTypes.DATE, allowNull: false },
          ...timestamps,
        },
        opts
      );

      // --- unapplied_payments (§7.6) ---------------------------------------
      await queryInterface.createTable(
        'unapplied_payments',
        {
          unapplied_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          // Nullable: money can arrive quoting no valid reference at all.
          unn_reference: { type: DataTypes.STRING(20), allowNull: true },
          transaction_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: { model: 'transactions', key: 'transaction_id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          student_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: { model: 'students', key: 'student_id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          provider_reference: { type: DataTypes.STRING(100), allowNull: true },
          amount_received: money({ allowNull: false }),
          amount_expected: money({ allowNull: true }),
          variance: money({ allowNull: true }),
          reason: {
            type: DataTypes.ENUM(
              'underpayment',
              'overpayment',
              'unknown_reference',
              'expired_reference',
              'duplicate_payment'
            ),
            allowNull: false,
          },
          status: {
            type: DataTypes.ENUM('open', 'resolved', 'expired'),
            allowNull: false,
            defaultValue: 'open',
          },
          resolution: {
            type: DataTypes.ENUM(
              'applied_to_intended_fee',
              'applied_to_other_fee',
              'marked_for_refund',
              'dismissed'
            ),
            allowNull: true,
          },
          payer_details: { type: DataTypes.JSONB, allowNull: true },
          resolution_note: { type: DataTypes.TEXT, allowNull: true },
          resolved_by_admin_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: { model: 'admin_users', key: 'admin_id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          deadline_at: { type: DataTypes.DATE, allowNull: false },
          resolved_at: { type: DataTypes.DATE, allowNull: true },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addIndex('unapplied_payments', ['status', 'deadline_at'], {
        name: 'unapplied_status_deadline_idx',
        ...opts,
      });
      await queryInterface.addIndex('unapplied_payments', ['student_id', 'status'], {
        name: 'unapplied_student_status_idx',
        ...opts,
      });
      // One unapplied row per settlement: the reconciliation sweep will race the
      // webhook it is compensating for, and both must not open a row.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uniq_unapplied_provider_reference
           ON unapplied_payments (provider_reference)
           WHERE provider_reference IS NOT NULL`,
        opts
      );

      // --- device_tokens (§7.8) ---------------------------------------------
      await queryInterface.createTable(
        'device_tokens',
        {
          device_token_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          student_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'students', key: 'student_id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          fcm_token: { type: DataTypes.STRING(255), allowNull: false, unique: true },
          platform: { type: DataTypes.ENUM('android', 'ios'), allowNull: false },
          last_seen_at: { type: DataTypes.DATE, allowNull: false },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addIndex('device_tokens', ['student_id'], {
        name: 'device_tokens_student_idx',
        ...opts,
      });

      // --- auth_tokens (§7.9) -----------------------------------------------
      await queryInterface.createTable(
        'auth_tokens',
        {
          token_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          student_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'students', key: 'student_id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          purpose: {
            type: DataTypes.ENUM('activation', 'password_reset'),
            allowNull: false,
          },
          // bcrypt hash of the OTP. The plaintext code exists only in the email.
          code_hash: { type: DataTypes.STRING(255), allowNull: false },
          expires_at: { type: DataTypes.DATE, allowNull: false },
          consumed_at: { type: DataTypes.DATE, allowNull: true },
          attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addIndex('auth_tokens', ['student_id', 'purpose', 'consumed_at'], {
        name: 'auth_tokens_student_purpose_idx',
        ...opts,
      });

      // --- refresh_tokens (§13.3) -------------------------------------------
      // Hashed at rest, rotated on every use, and grouped into families so that
      // replaying a consumed token can revoke every descendant at once.
      await queryInterface.createTable(
        'refresh_tokens',
        {
          refresh_token_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          subject_type: { type: DataTypes.ENUM('student', 'admin'), allowNull: false },
          subject_id: { type: DataTypes.INTEGER, allowNull: false },
          family_id: { type: DataTypes.UUID, allowNull: false },
          token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
          expires_at: { type: DataTypes.DATE, allowNull: false },
          consumed_at: { type: DataTypes.DATE, allowNull: true },
          revoked_at: { type: DataTypes.DATE, allowNull: true },
          revoked_reason: { type: DataTypes.STRING(100), allowNull: true },
          user_agent: { type: DataTypes.STRING(255), allowNull: true },
          ip_address: { type: DataTypes.STRING(45), allowNull: true },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addIndex('refresh_tokens', ['family_id'], {
        name: 'refresh_tokens_family_idx',
        ...opts,
      });
      await queryInterface.addIndex('refresh_tokens', ['subject_type', 'subject_id'], {
        name: 'refresh_tokens_subject_idx',
        ...opts,
      });

      // --- webhook_events (§7.10) -------------------------------------------
      await queryInterface.createTable(
        'webhook_events',
        {
          event_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          provider_reference: { type: DataTypes.STRING(100), allowNull: true },
          unn_reference: { type: DataTypes.STRING(20), allowNull: true },
          // The raw body, stored verbatim before parsing, so evidence survives a
          // parse failure (§9.5).
          raw_payload: { type: DataTypes.JSONB, allowNull: true },
          raw_body: { type: DataTypes.TEXT, allowNull: false },
          payload_hash: { type: DataTypes.STRING(64), allowNull: false },
          signature_valid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
          processing_status: {
            type: DataTypes.ENUM('received', 'processed', 'failed', 'ignored_duplicate'),
            allowNull: false,
            defaultValue: 'received',
          },
          error_detail: { type: DataTypes.TEXT, allowNull: true },
          received_at: { type: DataTypes.DATE, allowNull: false },
          processed_at: { type: DataTypes.DATE, allowNull: true },
          ...timestamps,
        },
        opts
      );
      // Replay detection: the same provider reference carrying the same payload
      // is the same event, however many times the bank sends it.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uniq_webhook_provider_payload
           ON webhook_events (provider_reference, payload_hash)
           WHERE provider_reference IS NOT NULL`,
        opts
      );
      await queryInterface.addIndex('webhook_events', ['received_at'], {
        name: 'webhook_events_received_idx',
        ...opts,
      });

      // --- outbox (§7.11) ----------------------------------------------------
      await queryInterface.createTable(
        'outbox',
        {
          outbox_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          event_type: { type: DataTypes.STRING(60), allowNull: false },
          payload: { type: DataTypes.JSONB, allowNull: false },
          status: {
            type: DataTypes.ENUM('pending', 'processing', 'done', 'dead'),
            allowNull: false,
            defaultValue: 'pending',
          },
          attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          next_attempt_at: { type: DataTypes.DATE, allowNull: false },
          last_error: { type: DataTypes.TEXT, allowNull: true },
          locked_at: { type: DataTypes.DATE, allowNull: true },
          completed_at: { type: DataTypes.DATE, allowNull: true },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addIndex('outbox', ['status', 'next_attempt_at'], {
        name: 'outbox_status_next_attempt_idx',
        ...opts,
      });

      // --- audit_log (§7.12) -------------------------------------------------
      // Append only. Never updated, never deleted.
      await queryInterface.createTable(
        'audit_log',
        {
          audit_id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
          actor_type: {
            type: DataTypes.ENUM('student', 'admin', 'system'),
            allowNull: false,
          },
          actor_id: { type: DataTypes.INTEGER, allowNull: true },
          action: { type: DataTypes.STRING(80), allowNull: false },
          entity_type: { type: DataTypes.STRING(60), allowNull: false },
          entity_id: { type: DataTypes.STRING(60), allowNull: true },
          before_state: { type: DataTypes.JSONB, allowNull: true },
          after_state: { type: DataTypes.JSONB, allowNull: true },
          ip_address: { type: DataTypes.STRING(45), allowNull: true },
          correlation_id: { type: DataTypes.STRING(64), allowNull: true },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize_NOW() },
        },
        opts
      );
      await queryInterface.addIndex('audit_log', ['entity_type', 'entity_id'], {
        name: 'audit_log_entity_idx',
        ...opts,
      });
      await queryInterface.addIndex('audit_log', ['created_at'], {
        name: 'audit_log_created_idx',
        ...opts,
      });

      // --- idempotency_keys (§9.1) ------------------------------------------
      // Replaying a key returns the original response rather than creating a
      // second transaction.
      await queryInterface.createTable(
        'idempotency_keys',
        {
          idempotency_key_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          key: { type: DataTypes.STRING(255), allowNull: false },
          scope: { type: DataTypes.STRING(120), allowNull: false },
          subject_type: { type: DataTypes.ENUM('student', 'admin'), allowNull: false },
          subject_id: { type: DataTypes.INTEGER, allowNull: false },
          request_hash: { type: DataTypes.STRING(64), allowNull: false },
          status: {
            type: DataTypes.ENUM('in_progress', 'completed'),
            allowNull: false,
            defaultValue: 'in_progress',
          },
          response_status: { type: DataTypes.INTEGER, allowNull: true },
          response_body: { type: DataTypes.JSONB, allowNull: true },
          expires_at: { type: DataTypes.DATE, allowNull: false },
          ...timestamps,
        },
        opts
      );
      await queryInterface.addConstraint('idempotency_keys', {
        fields: ['key', 'scope', 'subject_type', 'subject_id'],
        type: 'unique',
        name: 'uniq_idempotency_key_per_subject',
        transaction: t,
      });
      await queryInterface.addIndex('idempotency_keys', ['expires_at'], {
        name: 'idempotency_keys_expires_idx',
        ...opts,
      });

      // The audit log is append only, and that is enforced by the database
      // rather than by convention: a stray UPDATE or DELETE anywhere in the
      // codebase, or by hand in psql, is rejected outright.
      await queryInterface.sequelize.query(
        `CREATE OR REPLACE FUNCTION audit_log_is_append_only()
         RETURNS TRIGGER AS $$
         BEGIN
           RAISE EXCEPTION 'audit_log is append only; % is not permitted', TG_OP;
         END;
         $$ LANGUAGE plpgsql;`,
        opts
      );
      await queryInterface.sequelize.query(
        `CREATE TRIGGER audit_log_no_update_or_delete
           BEFORE UPDATE OR DELETE ON audit_log
           FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();`,
        opts
      );

      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query('DROP TRIGGER IF EXISTS audit_log_no_update_or_delete ON audit_log');
    await q.query('DROP FUNCTION IF EXISTS audit_log_is_append_only()');
    for (const table of [
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
    ]) {
      await queryInterface.dropTable(table, { cascade: true });
    }
    // Drop the enum types Sequelize created alongside the tables.
    const enums = await q.query(
      `SELECT t.typname FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typtype = 'e' AND n.nspname = current_schema()`,
      { type: q.QueryTypes.SELECT }
    );
    for (const row of enums) {
      await q.query(`DROP TYPE IF EXISTS "${row.typname}" CASCADE`);
    }
  },
};
