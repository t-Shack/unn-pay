'use strict';

/** Sandbox adapter backing store. Empty in a production deployment. */
module.exports = (sequelize, DataTypes) => {
  const SandboxVirtualAccount = sequelize.define(
    'SandboxVirtualAccount',
    {
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
    },
    { tableName: 'sandbox_virtual_accounts' }
  );

  return SandboxVirtualAccount;
};
