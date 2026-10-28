'use strict';

const Decimal = require('decimal.js');

/**
 * Money handling for UNN Pay.
 *
 * Rule from the specification (§7): never use a float for money. Amounts are
 * carried through the application as **integer kobo** (a JS safe integer), and
 * converted to a fixed two decimal string only at the database and presentation
 * boundaries. Decimal.js is used for the parse and format steps so no binary
 * floating point arithmetic ever touches a naira value.
 *
 * 1 naira = 100 kobo. NUMERIC(12,2) tops out at 9,999,999,999.99 naira, so kobo
 * values stay far inside Number.MAX_SAFE_INTEGER (9.007e15).
 */

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -15, toExpPos: 30 });

const MAX_KOBO = 999999999999; // NUMERIC(12,2) upper bound, in kobo.

class MoneyError extends Error {}

/**
 * Parse any accepted representation of an amount into integer kobo.
 * Accepts: integer kobo (via fromKobo), numeric strings ("1500.50"), Decimal,
 * and — only because Sequelize hands DECIMAL columns back as strings — never a
 * raw float. Passing a non integer Number is rejected outright.
 */
function toKobo(value) {
  if (value === null || value === undefined) {
    throw new MoneyError('Amount is required');
  }
  if (typeof value === 'number') {
    // A Number is only ever accepted when it is an exact integer number of
    // naira. Anything with a fraction must arrive as a string or Decimal so we
    // can be certain no binary rounding has already corrupted it.
    if (!Number.isInteger(value)) {
      throw new MoneyError(
        'Refusing to convert a fractional Number to money; pass a string or Decimal'
      );
    }
    return assertRange(value * 100);
  }
  const decimal = value instanceof Decimal ? value : new Decimal(String(value).trim());
  if (!decimal.isFinite()) throw new MoneyError('Amount is not a finite number');
  if (decimal.decimalPlaces() > 2) {
    throw new MoneyError('Amount has more than two decimal places');
  }
  const kobo = decimal.times(100);
  if (!kobo.isInteger()) throw new MoneyError('Amount is not a whole number of kobo');
  return assertRange(kobo.toNumber());
}

function assertRange(kobo) {
  if (!Number.isSafeInteger(kobo)) throw new MoneyError('Amount is out of safe integer range');
  if (Math.abs(kobo) > MAX_KOBO) throw new MoneyError('Amount exceeds the supported range');
  return kobo;
}

/** Integer kobo -> the fixed two decimal string a NUMERIC(12,2) column expects. */
function koboToDecimalString(kobo) {
  assertRange(kobo);
  const negative = kobo < 0;
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${negative ? '-' : ''}${naira}.${String(remainder).padStart(2, '0')}`;
}

/** Human presentation: 150050 -> "₦1,500.50". */
function formatNaira(kobo, { symbol = '₦' } = {}) {
  const plain = koboToDecimalString(kobo);
  const negative = plain.startsWith('-');
  const [whole, fraction] = (negative ? plain.slice(1) : plain).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${fraction}`;
}

const add = (a, b) => assertRange(a + b);
const subtract = (a, b) => assertRange(a - b);
const isZero = (kobo) => kobo === 0;
const isPositive = (kobo) => kobo > 0;

/**
 * Compare a settled amount against the expected amount.
 * Returns 'exact' | 'underpayment' | 'overpayment'.
 */
function compareToExpected(paidKobo, expectedKobo) {
  if (paidKobo === expectedKobo) return 'exact';
  return paidKobo < expectedKobo ? 'underpayment' : 'overpayment';
}

module.exports = {
  MoneyError,
  MAX_KOBO,
  toKobo,
  koboToDecimalString,
  formatNaira,
  add,
  subtract,
  isZero,
  isPositive,
  compareToExpected,
};
