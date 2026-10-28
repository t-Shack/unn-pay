'use strict';

module.exports = (sequelize, DataTypes) => {
  const AuditLog = sequelize.define(
    'AuditLog',
    {
      audit_id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      actor_type: { type: DataTypes.ENUM('student', 'admin', 'system'), allowNull: false },
      actor_id: { type: DataTypes.INTEGER, allowNull: true },
      action: { type: DataTypes.STRING(80), allowNull: false },
      entity_type: { type: DataTypes.STRING(60), allowNull: false },
      entity_id: { type: DataTypes.STRING(60), allowNull: true },
      before_state: { type: DataTypes.JSONB, allowNull: true },
      after_state: { type: DataTypes.JSONB, allowNull: true },
      ip_address: { type: DataTypes.STRING(45), allowNull: true },
      correlation_id: { type: DataTypes.STRING(64), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'audit_log',
      // Append only, and the database enforces it with a trigger as well.
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return AuditLog;
};
