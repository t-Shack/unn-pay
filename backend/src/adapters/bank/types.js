'use strict';

const Decimal = require('decimal.js');
const { toKobo } = require('../../lib/money');

/**
 * The internal settlement shape every adapter must produce (§5).
 *
 * Nothing outside an adapter ever sees a bank's own payload shape. This module
 * defines the normalised form and validates it at the boundary, so a
 * misbehaving adapter is caught where it is written rather than three services
 * downstream.
 *
 * @typedef {Object} NormalisedSettlement
 * @property {string} providerReference  The bank's own id for the settlement.
 * @property {string} unnReference       The UNN Payment Reference it was paid to.
 * @property {number} amountPaidKobo     Exact amount, in integer kobo.
 * @property {'NGN'} currency
 * @property {PaymentChannel} channel
 * @property {'successful'|'failed'|'pending'} status
 * @property {Date} paidAt
 * @property {string} [payerAccountName]
 * @property {string} [payerBank]
 * @property {Object} rawPayload         Stored verbatim for audit.
 */

const PAYMENT_CHANNELS = Object.freeze([
  'transfer',
  'ussd',
  'card',
  'pos',
  'bank_branch',
]);

const SETTLEMENT_STATUSES = Object.freeze(['successful', 'failed', 'pending']);

class SettlementShapeError extends Error {
  constructor(message) {
    super(`Adapter produced an invalid settlement: ${message}`);
    this.name = 'SettlementShapeError';
  }
}

/**
 * Validate and normalise an adapter's output. Amounts arrive as a decimal
 * string or Decimal and leave as integer kobo, so no float ever reaches the
 * services (§7).
 */
function normaliseSettlement(input) {
  if (!input || typeof input !== 'object') throw new SettlementShapeError('not an object');

  const { providerReference, unnReference, currency, channel, status, paidAt } = input;

  if (typeof providerReference !== 'string' || providerReference.trim() === '') {
    throw new SettlementShapeError('providerReference is required');
  }
  if (typeof unnReference !== 'string') {
    throw new SettlementShapeError('unnReference must be a string');
  }
  if (currency !== 'NGN') {
    throw new SettlementShapeError(`unsupported currency ${currency}`);
  }
  if (!PAYMENT_CHANNELS.includes(channel)) {
    throw new SettlementShapeError(`unknown channel ${channel}`);
  }
  if (!SETTLEMENT_STATUSES.includes(status)) {
    throw new SettlementShapeError(`unknown status ${status}`);
  }

  const paid = paidAt instanceof Date ? paidAt : new Date(paidAt);
  if (Number.isNaN(paid.getTime())) throw new SettlementShapeError('paidAt is not a valid date');

  let amountPaidKobo;
  try {
    amountPaidKobo =
      input.amountPaidKobo !== undefined
        ? toKobo(new Decimal(input.amountPaidKobo).dividedBy(100))
        : toKobo(input.amountPaid);
  } catch (error) {
    throw new SettlementShapeError(`amount is unusable (${error.message})`);
  }
  if (amountPaidKobo < 0) throw new SettlementShapeError('amount is negative');

  return Object.freeze({
    providerReference: providerReference.trim(),
    unnReference: unnReference.trim().toUpperCase(),
    amountPaidKobo,
    currency: 'NGN',
    channel,
    status,
    paidAt: paid,
    payerAccountName: input.payerAccountName || null,
    payerBank: input.payerBank || null,
    rawPayload: input.rawPayload && typeof input.rawPayload === 'object' ? input.rawPayload : {},
  });
}

module.exports = {
  PAYMENT_CHANNELS,
  SETTLEMENT_STATUSES,
  SettlementShapeError,
  normaliseSettlement,
};
