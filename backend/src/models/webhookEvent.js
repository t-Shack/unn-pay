'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebhookEvent = sequelize.define(
    'WebhookEvent',
    {
      event_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      provider_reference: { type: DataTypes.STRING(100), allowNull: true },
      unn_reference: { type: DataTypes.STRING(20), allowNull: true },
      raw_payload: { type: DataTypes.JSONB, allowNull: true },
      // The body exactly as it arrived, persisted before any parse attempt so
      // the evidence survives a parse failure (§9.5).
      raw_body: { type: DataTypes.TEXT, allowNull: false },
      payload_hash: { type: DataTypes.STRING(64), allowNull: false },
      signature_valid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      processing_status: {
        type: DataTypes.ENUM('received', 'processed', 'failed', 'ignored_duplicate'),
        allowNull: false,
        defaultValue: 'received',
      },
      error_detail: { type: DataTypes.TEXT, allowNull: true },
      received_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      processed_at: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'webhook_events' }
  );

  return WebhookEvent;
};
