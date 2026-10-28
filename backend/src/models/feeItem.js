'use strict';

module.exports = (sequelize, DataTypes) => {
  const FeeItem = sequelize.define(
    'FeeItem',
    {
      fee_item_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(150), allowNull: false },
      category: {
        type: DataTypes.ENUM('Tuition', 'Acceptance', 'Departmental', 'Hostel', 'Other'),
        allowNull: false,
      },
      // Authoritative price. The client never supplies an amount (§11.3).
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      department: { type: DataTypes.STRING(100), allowNull: true },
      level: { type: DataTypes.STRING(10), allowNull: true },
      session: { type: DataTypes.STRING(9), allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'fee_items' }
  );

  FeeItem.CATEGORIES = ['Tuition', 'Acceptance', 'Departmental', 'Hostel', 'Other'];

  FeeItem.associate = (models) => {
    FeeItem.hasMany(models.Transaction, { foreignKey: 'fee_item_id', as: 'transactions' });
  };

  return FeeItem;
};
