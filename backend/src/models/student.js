'use strict';

const MATRIC_PATTERN = /^\d{4}\/\d{6}$/;

module.exports = (sequelize, DataTypes) => {
  const Student = sequelize.define(
    'Student',
    {
      student_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      matric_number: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: true,
        validate: { is: { args: MATRIC_PATTERN, msg: 'Matric number must look like 2022/248400' } },
      },
      full_name: { type: DataTypes.STRING(100), allowNull: false },
      email: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
        validate: { isEmail: true },
      },
      phone: { type: DataTypes.STRING(20), allowNull: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: true },
      department: { type: DataTypes.STRING(100), allowNull: false },
      level: { type: DataTypes.STRING(10), allowNull: false },
      status: {
        type: DataTypes.ENUM('imported', 'active', 'suspended'),
        allowNull: false,
        defaultValue: 'imported',
      },
    },
    {
      tableName: 'students',
      defaultScope: { attributes: { exclude: ['password_hash'] } },
      scopes: {
        // Explicitly opted into by the auth service, and nowhere else.
        withSecrets: { attributes: { include: ['password_hash'] } },
      },
    }
  );

  Student.MATRIC_PATTERN = MATRIC_PATTERN;

  Student.associate = (models) => {
    Student.hasMany(models.Transaction, { foreignKey: 'student_id', as: 'transactions' });
    Student.hasMany(models.DeviceToken, { foreignKey: 'student_id', as: 'device_tokens' });
    Student.hasMany(models.AuthToken, { foreignKey: 'student_id', as: 'auth_tokens' });
  };

  /** Safe projection for API responses. Never includes the password hash. */
  Student.prototype.toPublicJSON = function toPublicJSON() {
    return {
      student_id: this.student_id,
      matric_number: this.matric_number,
      full_name: this.full_name,
      email: this.email,
      phone: this.phone,
      department: this.department,
      level: this.level,
      status: this.status,
    };
  };

  return Student;
};
