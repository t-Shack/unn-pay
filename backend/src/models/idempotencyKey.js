'use strict';

module.exports = (sequelize, DataTypes) => {
  const IdempotencyKey = sequelize.define(
    'IdempotencyKey',
    {
      idempotency_key_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      key: { type: DataTypes.STRING(255), allowNull: false },
      // The route the key was used against; a key is only valid for one route.
      scope: { type: DataTypes.STRING(120), allowNull: false },
      subject_type: { type: DataTypes.ENUM('student', 'admin'), allowNull: false },
      subject_id: { type: DataTypes.INTEGER, allowNull: false },
      // Guards against a client reusing a key with a different body.
      request_hash: { type: DataTypes.STRING(64), allowNull: false },
      status: {
        type: DataTypes.ENUM('in_progress', 'completed'),
        allowNull: false,
        defaultValue: 'in_progress',
      },
      response_status: { type: DataTypes.INTEGER, allowNull: true },
      response_body: { type: DataTypes.JSONB, allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'idempotency_keys' }
  );

  return IdempotencyKey;
};
