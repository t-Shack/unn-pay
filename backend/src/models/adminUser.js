'use strict';

module.exports = (sequelize, DataTypes) => {
  const AdminUser = sequelize.define(
    'AdminUser',
    {
      admin_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      staff_id: { type: DataTypes.STRING(50), allowNull: false, unique: true },
      full_name: { type: DataTypes.STRING(100), allowNull: false },
      email: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
        validate: { isEmail: true },
      },
      password_hash: { type: DataTypes.STRING(255), allowNull: false },
      role: {
        type: DataTypes.ENUM('Bursary Staff', 'Super Admin'),
        allowNull: false,
        defaultValue: 'Bursary Staff',
      },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'admin_users',
      defaultScope: { attributes: { exclude: ['password_hash'] } },
      scopes: { withSecrets: { attributes: { include: ['password_hash'] } } },
    }
  );

  AdminUser.ROLES = { STAFF: 'Bursary Staff', SUPER_ADMIN: 'Super Admin' };

  AdminUser.prototype.toPublicJSON = function toPublicJSON() {
    return {
      admin_id: this.admin_id,
      staff_id: this.staff_id,
      full_name: this.full_name,
      email: this.email,
      role: this.role,
      is_active: this.is_active,
      last_login_at: this.last_login_at,
    };
  };

  return AdminUser;
};
