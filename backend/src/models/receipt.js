'use strict';

module.exports = (sequelize, DataTypes) => {
  const Receipt = sequelize.define(
    'Receipt',
    {
      receipt_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      transaction_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      receipt_number: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      verification_code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
      signature: { type: DataTypes.STRING(128), allowNull: false },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      fee_item_description: { type: DataTypes.STRING(255), allowNull: false },
      issued_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'receipts' }
  );

  Receipt.associate = (models) => {
    Receipt.belongsTo(models.Transaction, { foreignKey: 'transaction_id', as: 'transaction' });
  };

  return Receipt;
};
