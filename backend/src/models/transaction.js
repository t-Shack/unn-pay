'use strict';

module.exports = (sequelize, DataTypes) => {
  const Transaction = sequelize.define(
    'Transaction',
    {
      transaction_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      unn_reference: { type: DataTypes.STRING(20), allowNull: false, unique: true },
      student_id: { type: DataTypes.INTEGER, allowNull: false },
      fee_item_id: { type: DataTypes.INTEGER, allowNull: false },
      expected_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      amount_paid: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      virtual_account_number: { type: DataTypes.STRING(20), allowNull: true },
      virtual_account_bank: { type: DataTypes.STRING(100), allowNull: true },
      // The bank's id for the settlement itself.
      provider_reference: { type: DataTypes.STRING(100), allowNull: true },
      // The bank's id for the virtual account, quoted back to release it.
      virtual_account_reference: { type: DataTypes.STRING(100), allowNull: true },
      virtual_account_released_at: { type: DataTypes.DATE, allowNull: true },
      // The channels the bank offered for this account, as returned at mint.
      virtual_account_channels: { type: DataTypes.ARRAY(DataTypes.STRING(20)), allowNull: true },
      adapter: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'sandbox' },
      channel: { type: DataTypes.STRING(20), allowNull: true },
      status: {
        type: DataTypes.ENUM('Pending', 'Successful', 'Failed', 'Expired', 'UnderReview'),
        allowNull: false,
        defaultValue: 'Pending',
      },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      paid_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'transactions' }
  );

  Transaction.STATUS = {
    PENDING: 'Pending',
    SUCCESSFUL: 'Successful',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    UNDER_REVIEW: 'UnderReview',
  };

  /**
   * The permitted state machine. A transaction only ever moves along one of
   * these edges, and only from inside a row locked database transaction (§9.1).
   * Successful and Failed are terminal; UnderReview can still be settled by a
   * Bursary resolution, and an Expired reference can still be pushed to review
   * when late money turns up against it.
   */
  Transaction.ALLOWED_TRANSITIONS = {
    Pending: ['Successful', 'Failed', 'Expired', 'UnderReview'],
    UnderReview: ['Successful', 'Failed'],
    Successful: [],
    Failed: [],
    Expired: ['UnderReview'],
  };

  Transaction.canTransition = (from, to) =>
    Boolean(Transaction.ALLOWED_TRANSITIONS[from]) &&
    Transaction.ALLOWED_TRANSITIONS[from].includes(to);

  Transaction.associate = (models) => {
    Transaction.belongsTo(models.Student, { foreignKey: 'student_id', as: 'student' });
    Transaction.belongsTo(models.FeeItem, { foreignKey: 'fee_item_id', as: 'fee_item' });
    Transaction.hasOne(models.Receipt, { foreignKey: 'transaction_id', as: 'receipt' });
    Transaction.hasMany(models.UnappliedPayment, {
      foreignKey: 'transaction_id',
      as: 'unapplied_payments',
    });
  };

  return Transaction;
};
