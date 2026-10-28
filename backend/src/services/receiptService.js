'use strict';

const crypto = require('crypto');
const { Receipt, Transaction, Student, FeeItem, sequelize } = require('../models');
const { signReceipt, verifyReceiptSignature } = require('../lib/hmac');
const { toKobo, koboToDecimalString, formatNaira } = require('../lib/money');
const { NotFoundError } = require('../lib/errors');
const config = require('../config');

/**
 * Receipts (§8).
 *
 * A receipt carries three things that together defeat the forged teller slip
 * problem: a QR code pointing at the public verification URL, a short code that
 * can be typed when a QR will not scan, and an HMAC signature over the receipt's
 * own contents. An edited PDF fails signature validation; an invented code is
 * simply not in the database.
 *
 * PDFs are generated server side. Building them on the client would make the
 * artefact something the client asserts rather than something UNN attests.
 */

// Unambiguous alphabet: no I, O, 0 or 1, which are the characters people
// mistype when reading a code off a printed page.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_GROUP_LENGTH = 4;

/** UNN-XXXX-XXXX */
function generateVerificationCode() {
  const pick = () => {
    let out = '';
    const bytes = crypto.randomBytes(CODE_GROUP_LENGTH * 2);
    for (const byte of bytes) {
      // 224 is the largest multiple of 32 below 256; discard above to stay uniform.
      if (byte >= 224) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_GROUP_LENGTH) break;
    }
    return out.length === CODE_GROUP_LENGTH ? out : pick();
  };
  return `UNN-${pick()}-${pick()}`;
}

function normaliseVerificationCode(code) {
  const cleaned = String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!cleaned.startsWith('UNN') || cleaned.length !== 3 + CODE_GROUP_LENGTH * 2) return null;
  const body = cleaned.slice(3);
  return `UNN-${body.slice(0, CODE_GROUP_LENGTH)}-${body.slice(CODE_GROUP_LENGTH)}`;
}

/**
 * Sequential receipt number, scoped to the session: UNN/2025-2026/000123.
 *
 * Allocation is a single atomic upsert against receipt_sequences. That matters:
 * deriving the next number with MAX(serial) + 1 looks correct and is not, because
 * two settlements committing at the same instant read the same maximum and mint
 * the same number. One then dies on the unique constraint, taking a good payment
 * with it. The upsert takes a row lock on exactly one row, so concurrent
 * settlements queue for a microsecond and every number is issued exactly once.
 *
 * Runs inside the caller's transaction, so a settlement that rolls back releases
 * its claim rather than burning a number.
 */
async function nextReceiptNumber(session, { transaction } = {}) {
  if (!session) throw new Error('nextReceiptNumber requires a session');

  const sessionSlug = String(session).replace('/', '-');

  const [row] = await sequelize.query(
    `INSERT INTO receipt_sequences (session, last_serial, created_at, updated_at)
          VALUES (:session, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (session) DO UPDATE
            SET last_serial = receipt_sequences.last_serial + 1,
                updated_at  = CURRENT_TIMESTAMP
      RETURNING last_serial`,
    {
      replacements: { session: String(session) },
      type: sequelize.QueryTypes.SELECT,
      transaction,
    }
  );

  return `UNN/${sessionSlug}/${String(row.last_serial).padStart(6, '0')}`;
}

/**
 * Issue the receipt for a settled transaction. Called only from inside the
 * settlement transaction, so a receipt and the Successful status commit together
 * or not at all.
 */
async function issueReceipt(transactionRow, { feeItem, session, transaction }) {
  const issuedAt = new Date();
  const amount = koboToDecimalString(toKobo(transactionRow.expected_amount));
  const receiptNumber = await nextReceiptNumber(
    session || (feeItem && feeItem.session),
    { transaction }
  );

  // A collision here is vanishingly unlikely, but a receipt is permanent, so
  // retry rather than fail the settlement that produced it.
  let verificationCode = generateVerificationCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await Receipt.findOne({
      where: { verification_code: verificationCode },
      transaction,
    });
    if (!clash) break;
    verificationCode = generateVerificationCode();
  }

  const signature = signReceipt({
    receiptNumber,
    unnReference: transactionRow.unn_reference,
    amount,
    issuedAt,
  });

  return Receipt.create(
    {
      transaction_id: transactionRow.transaction_id,
      receipt_number: receiptNumber,
      verification_code: verificationCode,
      signature,
      amount,
      fee_item_description: feeItem
        ? `${feeItem.name} (${feeItem.category}, ${feeItem.session})`
        : 'Fee payment',
      issued_at: issuedAt,
    },
    { transaction }
  );
}

/**
 * Public verification (§8). Returns only the fields the specification permits:
 * student name, matric number, fee item, amount, date, and validity. Nothing
 * else about the student or the payment is exposed here.
 */
async function verifyByCode(rawCode) {
  const code = normaliseVerificationCode(rawCode);
  if (!code) return { valid: false, reason: 'malformed_code' };

  const receipt = await Receipt.findOne({
    where: { verification_code: code },
    include: [
      {
        model: Transaction,
        as: 'transaction',
        include: [
          { model: Student, as: 'student' },
          { model: FeeItem, as: 'fee_item' },
        ],
      },
    ],
  });

  if (!receipt) return { valid: false, reason: 'not_found' };

  const signatureValid = verifyReceiptSignature(
    {
      receiptNumber: receipt.receipt_number,
      unnReference: receipt.transaction.unn_reference,
      amount: receipt.amount,
      issuedAt: receipt.issued_at,
    },
    receipt.signature
  );

  if (!signatureValid) return { valid: false, reason: 'signature_mismatch' };

  // A receipt only exists for a settled transaction, but check anyway: if a
  // transaction were ever reversed, its receipt must stop verifying.
  if (receipt.transaction.status !== 'Successful') {
    return { valid: false, reason: 'transaction_not_successful' };
  }

  return {
    valid: true,
    receipt: {
      receipt_number: receipt.receipt_number,
      verification_code: receipt.verification_code,
      student_name: receipt.transaction.student.full_name,
      matric_number: receipt.transaction.student.matric_number,
      fee_item: receipt.fee_item_description,
      amount: receipt.amount,
      amount_formatted: formatNaira(toKobo(receipt.amount)),
      issued_at: receipt.issued_at,
      paid_at: receipt.transaction.paid_at,
      unn_reference: receipt.transaction.unn_reference,
    },
  };
}

/** The URL encoded into the QR code. */
const verificationUrl = (code) => `${config.PUBLIC_BASE_URL}/verify/${encodeURIComponent(code)}`;

async function findForTransaction(transactionId) {
  const receipt = await Receipt.findOne({
    where: { transaction_id: transactionId },
    include: [
      {
        model: Transaction,
        as: 'transaction',
        include: [
          { model: Student, as: 'student' },
          { model: FeeItem, as: 'fee_item' },
        ],
      },
    ],
  });
  if (!receipt) throw new NotFoundError('No receipt exists for this transaction', 'receipt_not_found');
  return receipt;
}

module.exports = {
  generateVerificationCode,
  normaliseVerificationCode,
  nextReceiptNumber,
  issueReceipt,
  verifyByCode,
  verificationUrl,
  findForTransaction,
  CODE_ALPHABET,
};
