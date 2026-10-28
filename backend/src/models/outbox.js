'use strict';

module.exports = (sequelize, DataTypes) => {
  const Outbox = sequelize.define(
    'Outbox',
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
      next_attempt_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      last_error: { type: DataTypes.TEXT, allowNull: true },
      locked_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'outbox' }
  );

  Outbox.EVENT = {
    PAYMENT_SUCCESSFUL: 'payment.successful',
    PAYMENT_UNAPPLIED: 'payment.unapplied',
    UNAPPLIED_RESOLVED: 'unapplied.resolved',
    ACTIVATION_OTP: 'email.activation_otp',
    PASSWORD_RESET_OTP: 'email.password_reset_otp',
    BURSARY_ALERT: 'email.bursary_alert',
  };

  Outbox.MAX_ATTEMPTS = 8;

  return Outbox;
};
