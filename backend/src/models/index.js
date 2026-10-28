'use strict';

const fs = require('fs');
const path = require('path');
const { sequelize, Sequelize } = require('../db');

/**
 * Model registry. Every model file in this directory exports a factory taking
 * (sequelize, DataTypes) and may expose an `associate` hook, which runs once all
 * models are defined.
 *
 * Only services touch these (§4). Controllers never call the ORM directly.
 */
const db = {};
const basename = path.basename(__filename);

for (const file of fs.readdirSync(__dirname)) {
  if (file === basename || !file.endsWith('.js') || file.startsWith('.')) continue;
  const model = require(path.join(__dirname, file))(sequelize, Sequelize.DataTypes);
  db[model.name] = model;
}

for (const model of Object.values(db)) {
  if (typeof model.associate === 'function') model.associate(db);
}

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
