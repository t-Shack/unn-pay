'use strict';

module.exports = (sequelize, DataTypes) => {
  const DeviceToken = sequelize.define(
    'DeviceToken',
    {
      device_token_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      student_id: { type: DataTypes.INTEGER, allowNull: false },
      fcm_token: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      platform: { type: DataTypes.ENUM('android', 'ios'), allowNull: false },
      last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: 'device_tokens' }
  );

  DeviceToken.associate = (models) => {
    DeviceToken.belongsTo(models.Student, { foreignKey: 'student_id', as: 'student' });
  };

  return DeviceToken;
};
