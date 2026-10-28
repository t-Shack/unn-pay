'use strict';

const {
  generateReference,
  isValidReference,
  luhnCheckDigit,
  luhnIsValid,
  sessionYearDigits,
  normaliseReference,
  randomDigits,
} = require('../../src/lib/reference');

describe('UNN Payment Reference (§6)', () => {
  describe('format', () => {
    it('is UNN followed by exactly 12 digits', () => {
      const reference = generateReference({ session: '2025/2026' });
      expect(reference).toMatch(/^UNN\d{12}$/);
      expect(reference).toHaveLength(15);
    });

    it('encodes the session start year in digits 1-2', () => {
      expect(generateReference({ session: '2025/2026' }).slice(3, 5)).toBe('25');
      expect(generateReference({ session: '2019/2020' }).slice(3, 5)).toBe('19');
      expect(generateReference({ session: '2000/2001' }).slice(3, 5)).toBe('00');
    });

    it('encodes the month of issue in digits 3-4', () => {
      const august = generateReference({
        session: '2025/2026',
        issuedAt: new Date(Date.UTC(2025, 7, 15)),
      });
      expect(august.slice(5, 7)).toBe('08');

      const january = generateReference({
        session: '2025/2026',
        issuedAt: new Date(Date.UTC(2026, 0, 3)),
      });
      expect(january.slice(5, 7)).toBe('01');
    });

    it('rejects a malformed session', () => {
      expect(() => generateReference({ session: '2025' })).toThrow(/Invalid session format/);
      expect(() => generateReference({ session: '2025-2026' })).toThrow(/Invalid session format/);
      // The second year must follow the first.
      expect(() => generateReference({ session: '2025/2027' })).toThrow(/Invalid session range/);
    });

    it('extracts session year digits correctly', () => {
      expect(sessionYearDigits('2025/2026')).toBe('25');
      expect(sessionYearDigits('2009/2010')).toBe('09');
    });
  });

  describe('Luhn check digit', () => {
    it('validates a well known Luhn sequence', () => {
      // 7992739871x -> check digit 3, the canonical textbook example.
      expect(luhnCheckDigit('7992739871')).toBe(3);
      expect(luhnIsValid('79927398713')).toBe(true);
      expect(luhnIsValid('79927398710')).toBe(false);
    });

    it('accepts every reference it generates', () => {
      for (let i = 0; i < 500; i += 1) {
        expect(isValidReference(generateReference({ session: '2025/2026' }))).toBe(true);
      }
    });

    it('rejects a single mistyped digit — the point of the check digit', () => {
      const reference = generateReference({ session: '2025/2026' });

      // Change each digit in turn to every other value; every single-digit
      // error must be caught, which is precisely Luhn's guarantee.
      for (let position = 3; position < reference.length; position += 1) {
        const original = Number(reference[position]);
        for (let replacement = 0; replacement <= 9; replacement += 1) {
          if (replacement === original) continue;
          const mistyped =
            reference.slice(0, position) + replacement + reference.slice(position + 1);
          expect(isValidReference(mistyped)).toBe(false);
        }
      }
    });

    it('rejects adjacent transpositions, except Luhn\'s known 0/9 blind spot', () => {
      // Luhn detects every adjacent transposition of distinct digits except
      // 09 <-> 90, which is a property of the algorithm itself, not of this
      // implementation. Asserting exactly that is stronger than asserting a
      // percentage: it fails if anything *else* ever starts slipping through.
      const escapingPairs = new Set();
      let attempted = 0;
      let caught = 0;

      for (let i = 0; i < 200; i += 1) {
        const reference = generateReference({ session: '2025/2026' });
        const checkDigitIndex = reference.length - 1;

        // Swap adjacent body digits only; the check digit is not part of the
        // body and swapping into it is a different class of error.
        for (let p = 3; p < checkDigitIndex - 1; p += 1) {
          const a = reference[p];
          const b = reference[p + 1];
          if (a === b) continue;

          attempted += 1;
          const swapped = reference.slice(0, p) + b + a + reference.slice(p + 2);
          if (isValidReference(swapped)) escapingPairs.add([a, b].sort().join(''));
          else caught += 1;
        }
      }

      expect(attempted).toBeGreaterThan(1000);
      expect([...escapingPairs]).toEqual(['09']);
      expect(caught).toBeGreaterThan(0);
    });
  });

  describe('validation of untrusted input', () => {
    it.each([
      ['', 'empty'],
      ['UNN', 'prefix only'],
      ['UNN12345678901', 'only 11 digits'],
      ['UNN1234567890123', '13 digits'],
      ['ABC240815739104', 'wrong prefix'],
      ['UNN24081573910A', 'non numeric'],
      [null, 'null'],
      [undefined, 'undefined'],
      [12345, 'a number'],
      [{}, 'an object'],
    ])('rejects %p (%s)', (input) => {
      expect(isValidReference(input)).toBe(false);
    });

    it('normalises spacing, hyphens and case before validating', () => {
      const reference = generateReference({ session: '2025/2026' });
      const messy = `  ${reference.toLowerCase().replace(/(.{4})/g, '$1-')}  `;
      expect(isValidReference(normaliseReference(messy))).toBe(true);
    });
  });

  describe('unguessability', () => {
    it('uses a CSPRNG, not a sequential counter', () => {
      const references = Array.from({ length: 200 }, () =>
        generateReference({ session: '2025/2026' })
      );
      const randomParts = references.map((r) => Number(r.slice(7, 14)));

      // A counter would produce a constant difference between consecutive
      // values. Random ones will not.
      const deltas = new Set();
      for (let i = 1; i < randomParts.length; i += 1) {
        deltas.add(randomParts[i] - randomParts[i - 1]);
      }
      expect(deltas.size).toBeGreaterThan(150);
    });

    it('produces uniformly distributed digits (no modulo bias)', () => {
      const digits = randomDigits(30000);
      const counts = new Array(10).fill(0);
      for (const digit of digits) counts[Number(digit)] += 1;

      // Each digit should appear ~3000 times; allow generous slack.
      for (const count of counts) {
        expect(count).toBeGreaterThan(2600);
        expect(count).toBeLessThan(3400);
      }
    });

    it('is overwhelmingly likely to be unique, but collisions are possible', () => {
      // 7 random digits is 10 million values per session-month prefix. At 5,000
      // references the birthday bound puts collisions in the low single digits,
      // which is exactly why minting retries against the unique constraint
      // rather than assuming uniqueness.
      const seen = new Set();
      for (let i = 0; i < 5000; i += 1) seen.add(generateReference({ session: '2025/2026' }));
      expect(seen.size).toBeGreaterThan(4990);
    });
  });
});
