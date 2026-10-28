'use strict';

/**
 * Backing store for SandboxAdapter.
 *
 * This table exists so the sandbox behaves like a real bank across process
 * boundaries: the API mints an account in one process and the worker's
 * reconciliation sweep finds the settlement in another. Without it, sandbox
 * state would live in one process's memory and the worker would never see it.
 *
 * It is written to only by SandboxAdapter and the non production /sandbox
 * routes. With any real bank adapter selected, it stays empty.
 */

const { DataTypes, Sequelize } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable('sandbox_settlements', {
      sandbox_settlement_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      provider_reference: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      unn_reference: { type: DataTypes.STRING(20), allowNull: false },
      account_number: { type: DataTypes.STRING(20), allowNull: true },
      amount_paid: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      channel: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'transfer' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'successful' },
      payer_account_name: { type: DataTypes.STRING(120), allowNull: true },
      payer_bank: { type: DataTypes.STRING(120), allowNull: true },
      paid_at: { type: DataTypes.DATE, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('sandbox_settlements', ['paid_at'], {
      name: 'sandbox_settlements_paid_at_idx',
    });
    await queryInterface.addIndex('sandbox_settlements', ['unn_reference'], {
      name: 'sandbox_settlements_unn_reference_idx',
    });

    // Virtual accounts the sandbox has minted, so fetchSettlement and
    // listSettlements can behave like a real bank's ledger.
    await queryInterface.createTable('sandbox_virtual_accounts', {
      sandbox_virtual_account_id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      provider_reference: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      unn_reference: { type: DataTypes.STRING(20), allowNull: false, unique: true },
      account_number: { type: DataTypes.STRING(20), allowNull: false },
      bank_name: { type: DataTypes.STRING(100), allowNull: false },
      expected_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      payer_name: { type: DataTypes.STRING(120), allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      released_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sandbox_settlements');
    await queryInterface.dropTable('sandbox_virtual_accounts');
  },
};
