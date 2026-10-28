'use strict';

module.exports = (sequelize, DataTypes) => {
  const StudentImport = sequelize.define(
    'StudentImport',
    {
      import_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      admin_id: { type: DataTypes.INTEGER, allowNull: false },
      filename: { type: DataTypes.STRING(255), allowNull: false },
      session: { type: DataTypes.STRING(9), allowNull: false },
      row_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      success_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failure_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // A preview is validated but uncommitted; nothing is written to students
      // until an admin confirms it (§11.6).
      status: {
        type: DataTypes.ENUM('previewed', 'committed', 'rejected'),
        allowNull: false,
        defaultValue: 'previewed',
      },
      error_report: { type: DataTypes.JSONB, allowNull: true },
    },
    { tableName: 'student_imports' }
  );

  StudentImport.associate = (models) => {
    StudentImport.belongsTo(models.AdminUser, { foreignKey: 'admin_id', as: 'admin' });
  };

  return StudentImport;
};
