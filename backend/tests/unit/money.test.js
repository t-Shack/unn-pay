'use strict';

const Decimal = require('decimal.js');
const {
  toKobo,
  koboToDecimalString,
  formatNaira,
  add,
  subtract,
  compareToExpected,
  MoneyError,
} = require('../../src/lib/money');

describe('Money (§7 — never a float)', () => {
  describe('toKobo', () => {
    it('converts decimal strings exactly', () => {
      expect(toKobo('1500.50')).toBe(150050);
      expect(toKobo('0.01')).toBe(1);
      expect(toKobo('68500.00')).toBe(6850000);
      expect(toKobo('0')).toBe(0);
    });

    it('accepts whole naira as an integer Number', () => {
      expect(toKobo(1500)).toBe(150000);
      expect(toKobo(0)).toBe(0);
    });

    it('refuses a fractional Number outright', () => {
      // This is the guard that matters: 0.1 + 0.2 is 0.30000000000000004, and a
      // system that quietly accepts it will eventually be a kobo out.
      expect(() => toKobo(0.1 + 0.2)).toThrow(MoneyError);
      expect(() => toKobo(1500.5)).toThrow(/Refusing to convert a fractional Number/);
    });

    it('handles the classic float traps exactly when given as strings', () => {
      // In integer kobo this is exact, where 0.1 + 0.2 !== 0.3 in binary floats.
      expect(toKobo('0.1') + toKobo('0.2')).toBe(toKobo('0.30'));
      // 1.005 is the canonical rounding trap; it is a sub kobo amount and is
      // rejected rather than silently rounded either way.
      expect(() => toKobo('1.005')).toThrow(/more than two decimal places/);
    });

    it('accepts Decimal instances', () => {
      expect(toKobo(new Decimal('1500.50'))).toBe(150050);
    });

    it('rejects amounts with more than two decimal places', () => {
      expect(() => toKobo('10.123')).toThrow(/more than two decimal places/);
    });

    it('rejects amounts beyond NUMERIC(12,2)', () => {
      expect(() => toKobo('10000000000.00')).toThrow(/exceeds the supported range/);
    });

    it.each([null, undefined])('rejects %p', (value) => {
      expect(() => toKobo(value)).toThrow(MoneyError);
    });

    it('rejects non numeric strings', () => {
      expect(() => toKobo('abc')).toThrow();
      expect(() => toKobo('')).toThrow();
    });
  });

  describe('koboToDecimalString', () => {
    it('always produces exactly two decimal places', () => {
      expect(koboToDecimalString(150050)).toBe('1500.50');
      expect(koboToDecimalString(100)).toBe('1.00');
      expect(koboToDecimalString(5)).toBe('0.05');
      expect(koboToDecimalString(0)).toBe('0.00');
    });

    it('handles negatives, which is how a variance is expressed', () => {
      expect(koboToDecimalString(-150050)).toBe('-1500.50');
      expect(koboToDecimalString(-5)).toBe('-0.05');
    });

    it('round trips through toKobo without loss', () => {
      for (const kobo of [0, 1, 99, 100, 150050, 6850000, 999999999999]) {
        expect(toKobo(koboToDecimalString(kobo))).toBe(kobo);
      }
    });
  });

  describe('formatNaira', () => {
    it('groups thousands and keeps two decimals', () => {
      expect(formatNaira(6850000)).toBe('₦68,500.00');
      expect(formatNaira(123456789)).toBe('₦1,234,567.89');
      expect(formatNaira(5)).toBe('₦0.05');
      expect(formatNaira(-150000)).toBe('-₦1,500.00');
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts in integer kobo', () => {
      expect(add(150050, 49950)).toBe(200000);
      expect(subtract(200000, 150050)).toBe(49950);
    });

    it('refuses to leave the safe range', () => {
      expect(() => add(999999999999, 100)).toThrow(/exceeds the supported range/);
    });
  });

  describe('compareToExpected — the trigger for §10', () => {
    it('classifies exact, under and over payment', () => {
      expect(compareToExpected(6850000, 6850000)).toBe('exact');
      expect(compareToExpected(6849999, 6850000)).toBe('underpayment');
      expect(compareToExpected(6850001, 6850000)).toBe('overpayment');
    });

    it('treats a one kobo difference as a mismatch, not a rounding tolerance', () => {
      // There is deliberately no tolerance band: money that does not match goes
      // to a human, it is never silently absorbed.
      expect(compareToExpected(toKobo('68499.99'), toKobo('68500.00'))).toBe('underpayment');
    });
  });
});
