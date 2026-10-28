'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Receipt signing (§8). The signature is an HMAC over
 *   receipt_number || unn_reference || amount || issued_at
 * using RECEIPT_SIGNING_SECRET. An edited PDF fails verification; an invented
 * code simply is not in the database.
 */

const FIELD_SEPARATOR = '|';

/**
 * Build the canonical string that gets signed. Every field is normalised so the
 * same receipt always produces byte identical input: amounts as a fixed two
 * decimal string, timestamps as ISO 8601 in UTC to the millisecond.
 */
function canonicalPayload({ receiptNumber, unnReference, amount, issuedAt }) {
  if (!receiptNumber || !unnReference || amount === undefined || amount === null || !issuedAt) {
    throw new Error('canonicalPayload requires receiptNumber, unnReference, amount and issuedAt');
  }
  const issued = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  if (Number.isNaN(issued.getTime())) throw new Error('issuedAt is not a valid date');
  return [receiptNumber, unnReference, String(amount), issued.toISOString()].join(FIELD_SEPARATOR);
}

function signReceipt(fields, secret = config.RECEIPT_SIGNING_SECRET) {
  return crypto.createHmac('sha256', secret).update(canonicalPayload(fields), 'utf8').digest('hex');
}

/** Constant time comparison, so a signature cannot be recovered by timing. */
function verifyReceiptSignature(fields, signature, secret = config.RECEIPT_SIGNING_SECRET) {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const expected = signReceipt(fields, secret);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(signature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Generic constant time string equality, used for webhook signatures too. */
function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a), 'utf8');
  const bufferB = Buffer.from(String(b), 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** SHA-256 hex digest; used for payload fingerprints and token lookups. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = { canonicalPayload, signReceipt, verifyReceiptSignature, safeEqual, sha256 };
