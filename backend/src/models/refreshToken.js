'use strict';

module.exports = (sequelize, DataTypes) => {
  const RefreshToken = sequelize.define(
    'RefreshToken',
    {
      refresh_token_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      subject_type: { type: DataTypes.ENUM('student', 'admin'), allowNull: false },
      subject_id: { type: DataTypes.INTEGER, allowNull: false },
      // Every token issued from one login shares a family. Replaying a consumed
      // token revokes the whole family (§13.3).
      family_id: { type: DataTypes.UUID, allowNull: false },
      token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
      revoked_reason: { type: DataTypes.STRING(100), allowNull: true },
      user_agent: { type: DataTypes.STRING(255), allowNull: true },
      ip_address: { type: DataTypes.STRING(45), allowNull: true },
    },
    { tableName: 'refresh_tokens' }
  );

  RefreshToken.prototype.isUsable = function isUsable(now = new Date()) {
    return !this.consumed_at && !this.revoked_at && this.expires_at > now;
  };

  return RefreshToken;
};
