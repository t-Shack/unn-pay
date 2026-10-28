'use strict';

/**
 * Gapless, concurrency safe receipt numbering.
 *
 * Receipt numbers are sequential per session (UNN/2025-2026/000123). Deriving
 * the next one with MAX(serial) + 1 is not safe under concurrency: two
 * settlements committing at the same instant both read the same maximum, both
 * mint the same number, and one of them fails on the unique constraint — taking
 * an otherwise perfectly good payment down with it.
 *
 * This table makes allocation atomic. A single
 *   INSERT ... ON CONFLICT DO UPDATE SET last_serial = last_serial + 1 RETURNING
 * takes a row lock on exactly one row, so concurrent settlements queue behind
 * each other for the microsecond it takes to claim a number, and every number is
 * issued exactly once with no gaps.
 */

const { DataTypes, Sequelize } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable('receipt_sequences', {
      session: { type: DataTypes.STRING(9), primaryKey: true },
      last_serial: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // Backfill from any receipts that already exist, so an upgrade never
    // re-issues a number that has already been printed.
    await queryInterface.sequelize.query(`
      INSERT INTO receipt_sequences (session, last_serial, created_at, updated_at)
      SELECT
        REPLACE(SPLIT_PART(receipt_number, '/', 2), '-', '/') AS session,
        MAX(CAST(SPLIT_PART(receipt_number, '/', 3) AS INTEGER)) AS last_serial,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM receipts
      GROUP BY 1
      ON CONFLICT (session) DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('receipt_sequences');
  },
};
