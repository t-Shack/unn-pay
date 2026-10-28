'use strict';

/** Sandbox adapter backing store. Empty in a production deployment. */
module.exports = (sequelize, DataTypes) => {
  const SandboxSettlement = sequelize.define(
    'SandboxSettlement',
    {
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
    },
    { tableName: 'sandbox_settlements' }
  );

  return SandboxSettlement;
};
