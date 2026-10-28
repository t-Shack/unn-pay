'use strict';

module.exports = (sequelize, DataTypes) => {
  const AuthToken = sequelize.define(
    'AuthToken',
    {
      token_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      student_id: { type: DataTypes.INTEGER, allowNull: false },
      purpose: { type: DataTypes.ENUM('activation', 'password_reset'), allowNull: false },
      // bcrypt hash of the 6 digit OTP; the plaintext exists only in the email.
      code_hash: { type: DataTypes.STRING(255), allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      attempt_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'auth_tokens' }
  );

  AuthToken.PURPOSE = { ACTIVATION: 'activation', PASSWORD_RESET: 'password_reset' };
  AuthToken.MAX_ATTEMPTS = 5;
  AuthToken.TTL_MINUTES = 15;

  AuthToken.associate = (models) => {
    AuthToken.belongsTo(models.Student, { foreignKey: 'student_id', as: 'student' });
  };

  return AuthToken;
};
