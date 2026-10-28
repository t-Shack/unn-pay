'use strict';

const crypto = require('crypto');

/**
 * The UNN Payment Reference (§6).
 *
 * Format: "UNN" followed by 12 digits.
 *   digits 1-2   last two digits of the session start year
 *   digits 3-4   month of issue, zero padded
 *   digits 5-11  cryptographically random (CSPRNG, never sequential)
 *   digit  12    Luhn check digit over the preceding 11 digits
 *
 * The check digit exists so the mobile app and the dashboard can reject a
 * mistyped reference locally, with no network round trip. The randomness exists
 * so references are not guessable — a sequential counter would let anyone
 * enumerate other students' payments.
 */

const PREFIX = 'UNN';
const DIGIT_COUNT = 12;
const RANDOM_DIGITS = 7;
const REFERENCE_PATTERN = /^UNN\d{12}$/;

/** Luhn check digit for a string of digits. */
function luhnCheckDigit(digits) {
  if (!/^\d+$/.test(digits)) throw new Error('luhnCheckDigit expects digits only');
  let sum = 0;
  // The check digit will sit at the far right, so the rightmost body digit is
  // doubled: walk right to left, doubling every other digit starting at index 0.
  for (let i = digits.length - 1, position = 0; i >= 0; i -= 1, position += 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (position % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when the full 12 digit body carries a valid Luhn check digit. */
function luhnIsValid(digits) {
  if (!/^\d{2,}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = digits.charCodeAt(digits.length - 1) - 48;
  return luhnCheckDigit(body) === check;
}

/** Uniformly distributed random digit string, free of modulo bias. */
function randomDigits(count) {
  let out = '';
  while (out.length < count) {
    const bytes = crypto.randomBytes(count * 2);
    for (const byte of bytes) {
      // 250 is the largest multiple of 10 below 256; discard above it so every
      // digit is equally likely.
      if (byte >= 250) continue;
      out += String(byte % 10);
      if (out.length === count) break;
    }
  }
  return out;
}

/**
 * Extract the two digit year from a session string such as "2025/2026".
 * The session start year is used, so every reference minted in a session shares
 * a prefix regardless of which calendar year it was issued in.
 */
function sessionYearDigits(session) {
  const match = /^(\d{4})\/(\d{4})$/.exec(String(session || '').trim());
  if (!match) throw new Error(`Invalid session format: ${session} (expected YYYY/YYYY)`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end !== start + 1) throw new Error(`Invalid session range: ${session}`);
  return String(start % 100).padStart(2, '0');
}

/**
 * Mint a reference. `issuedAt` is injectable so tests are deterministic.
 */
function generateReference({ session, issuedAt = new Date() } = {}) {
  const year = sessionYearDigits(session);
  const month = String(issuedAt.getUTCMonth() + 1).padStart(2, '0');
  const random = randomDigits(RANDOM_DIGITS);
  const body = `${year}${month}${random}`;
  if (body.length !== DIGIT_COUNT - 1) {
    throw new Error('Reference body assembled to the wrong length');
  }
  return `${PREFIX}${body}${luhnCheckDigit(body)}`;
}

/**
 * Validate a reference offline: shape first, then the check digit. Used by the
 * API, the dashboard, and the mobile app so a typo never becomes a lookup.
 */
function isValidReference(reference) {
  if (typeof reference !== 'string') return false;
  const trimmed = reference.trim().toUpperCase();
  if (!REFERENCE_PATTERN.test(trimmed)) return false;
  return luhnIsValid(trimmed.slice(PREFIX.length));
}

/** Normalise user input: trim, uppercase, strip spaces and hyphens. */
function normaliseReference(reference) {
  if (typeof reference !== 'string') return '';
  return reference.replace(/[\s-]/g, '').toUpperCase();
}

module.exports = {
  PREFIX,
  REFERENCE_PATTERN,
  luhnCheckDigit,
  luhnIsValid,
  randomDigits,
  sessionYearDigits,
  generateReference,
  isValidReference,
  normaliseReference,
};
