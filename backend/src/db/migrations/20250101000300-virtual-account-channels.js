'use strict';

/**
 * Persist the payment channels the bank offered when it minted the account.
 *
 * They were returned by the mint call and passed straight to the initiate
 * response, but never stored. Every later read of the payment (the app's poll,
 * opening it from history, an account minted by the worker after an outage)
 * therefore had no channels, and the app's "you can pay any of these ways" card
 * disappeared ten seconds after it first appeared.
 *
 * Nullable: rows minted before this migration simply have none recorded.
 */

const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('transactions', 'virtual_account_channels', {
      type: DataTypes.ARRAY(DataTypes.STRING(20)),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'virtual_account_channels');
  },
};
