'use strict';

module.exports = (sequelize, DataTypes) => {
  const UnappliedPayment = sequelize.define(
    'UnappliedPayment',
    {
      unapplied_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      unn_reference: { type: DataTypes.STRING(20), allowNull: true },
      transaction_id: { type: DataTypes.INTEGER, allowNull: true },
      student_id: { type: DataTypes.INTEGER, allowNull: true },
      provider_reference: { type: DataTypes.STRING(100), allowNull: true },
      amount_received: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      amount_expected: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      variance: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
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
      resolved_by_admin_id: { type: DataTypes.INTEGER, allowNull: true },
      deadline_at: { type: DataTypes.DATE, allowNull: false },
      resolved_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'unapplied_payments' }
  );

  UnappliedPayment.REASONS = {
    UNDERPAYMENT: 'underpayment',
    OVERPAYMENT: 'overpayment',
    UNKNOWN_REFERENCE: 'unknown_reference',
    EXPIRED_REFERENCE: 'expired_reference',
    DUPLICATE_PAYMENT: 'duplicate_payment',
  };

  UnappliedPayment.RESOLUTIONS = {
    APPLIED_TO_INTENDED_FEE: 'applied_to_intended_fee',
    APPLIED_TO_OTHER_FEE: 'applied_to_other_fee',
    MARKED_FOR_REFUND: 'marked_for_refund',
    DISMISSED: 'dismissed',
  };

  UnappliedPayment.associate = (models) => {
    UnappliedPayment.belongsTo(models.Transaction, {
      foreignKey: 'transaction_id',
      as: 'transaction',
    });
    UnappliedPayment.belongsTo(models.Student, { foreignKey: 'student_id', as: 'student' });
    UnappliedPayment.belongsTo(models.AdminUser, {
      foreignKey: 'resolved_by_admin_id',
      as: 'resolved_by',
    });
  };

  return UnappliedPayment;
};
