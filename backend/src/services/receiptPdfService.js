'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { DateTime } = require('luxon');
const { formatNaira, toKobo } = require('../lib/money');
const { registerFonts, SANS, SANS_BOLD } = require('../lib/pdfFonts');
const { verificationUrl } = require('./receiptService');

/**
 * Server side receipt PDF generation (§8).
 *
 * Built here rather than on the client so the artefact is something UNN
 * attests to, not something a phone asserts. The document carries the QR code,
 * the short verification code, and the receipt number, so any of the three
 * routes back to the authoritative record.
 */

const WAT = 'Africa/Lagos';
const GREEN = '#0B6E4F';
const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#D1D5DB';

const formatWat = (date) =>
  DateTime.fromJSDate(new Date(date)).setZone(WAT).toFormat("d LLLL yyyy 'at' HH:mm 'WAT'");

/**
 * Render the receipt and resolve to a Buffer.
 * @param {object} receipt a Receipt with `transaction` -> `student`, `fee_item`
 * @returns {Promise<Buffer>}
 */
async function renderReceiptPdf(receipt) {
  const transaction = receipt.transaction;
  const student = transaction.student;

  const qrDataUrl = await QRCode.toDataURL(verificationUrl(receipt.verification_code), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: `UNN Pay Receipt ${receipt.receipt_number}`,
      Author: 'University of Nigeria, Nsukka',
      Subject: receipt.fee_item_description,
      Keywords: `${receipt.receipt_number} ${transaction.unn_reference}`,
    },
  });
  registerFonts(doc);

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const { width } = doc.page;
  const left = doc.page.margins.left;
  const contentWidth = width - left - doc.page.margins.right;

  // --- header --------------------------------------------------------------
  doc.rect(0, 0, width, 96).fill(GREEN);
  doc
    .fillColor('#FFFFFF')
    .font(SANS_BOLD)
    .fontSize(18)
    .text('UNIVERSITY OF NIGERIA, NSUKKA', left, 30, { width: contentWidth });
  doc
    .font(SANS)
    .fontSize(11)
    .text('Bursary Department  ·  Official Payment Receipt', left, 54, { width: contentWidth });

  doc.fillColor(INK).font(SANS_BOLD).fontSize(22).text('PAYMENT RECEIPT', left, 128);
  doc
    .font(SANS)
    .fontSize(10)
    .fillColor(MUTED)
    .text(`Receipt No. ${receipt.receipt_number}`, left, 156);

  // --- amount panel --------------------------------------------------------
  const panelTop = 186;
  doc.roundedRect(left, panelTop, contentWidth, 74, 6).fillAndStroke('#F0FDF4', GREEN);
  doc
    .fillColor(MUTED)
    .font(SANS)
    .fontSize(9)
    .text('AMOUNT PAID', left + 18, panelTop + 16);
  doc
    .fillColor(GREEN)
    .font(SANS_BOLD)
    .fontSize(26)
    .text(formatNaira(toKobo(receipt.amount)), left + 18, panelTop + 32);
  doc
    .fillColor(GREEN)
    .font(SANS_BOLD)
    .fontSize(11)
    .text('PAID IN FULL', left + contentWidth - 130, panelTop + 40, {
      width: 112,
      align: 'right',
    });

  // --- details -------------------------------------------------------------
  let y = panelTop + 100;

  const row = (label, value) => {
    doc.fillColor(MUTED).font(SANS).fontSize(9).text(label.toUpperCase(), left, y);
    doc
      .fillColor(INK)
      .font(SANS_BOLD)
      .fontSize(11)
      .text(String(value), left + 170, y - 2, { width: contentWidth - 170 });
    y += 26;
    doc.moveTo(left, y - 8).lineTo(left + contentWidth, y - 8).strokeColor(RULE).lineWidth(0.5).stroke();
  };

  row('Student', student.full_name);
  row('Matric number', student.matric_number);
  row('Department', student.department);
  row('Level', student.level);
  row('Fee item', receipt.fee_item_description);
  row('UNN payment reference', transaction.unn_reference);
  row('Payment channel', channelLabel(transaction.channel));
  row('Paid at', formatWat(transaction.paid_at || receipt.issued_at));
  row('Issued at', formatWat(receipt.issued_at));

  // --- verification block --------------------------------------------------
  const verifyTop = y + 14;
  doc.roundedRect(left, verifyTop, contentWidth, 150, 6).fillAndStroke('#F9FAFB', RULE);

  doc.image(qrBuffer, left + 16, verifyTop + 16, { width: 118, height: 118 });

  const textLeft = left + 152;
  doc
    .fillColor(INK)
    .font(SANS_BOLD)
    .fontSize(12)
    .text('Verify this receipt', textLeft, verifyTop + 20);
  doc
    .fillColor(MUTED)
    .font(SANS)
    .fontSize(9.5)
    .text(
      'Scan the code, or enter the verification code below at the address shown. ' +
        'A genuine receipt returns a green valid result carrying these exact details.',
      textLeft,
      verifyTop + 40,
      { width: contentWidth - 168 }
    );

  doc
    .fillColor(INK)
    .font('Courier-Bold')
    .fontSize(17)
    .text(receipt.verification_code, textLeft, verifyTop + 84);

  doc
    .fillColor(MUTED)
    .font(SANS)
    .fontSize(9)
    .text(verificationUrl(receipt.verification_code), textLeft, verifyTop + 110, {
      width: contentWidth - 168,
    });

  // --- footer --------------------------------------------------------------
  const footerY = verifyTop + 172;
  doc
    .fillColor(MUTED)
    .font(SANS)
    .fontSize(8)
    .text(
      'This receipt is digitally signed by UNN Pay. Any alteration invalidates the signature and ' +
        'the receipt will fail verification. Retain this document as proof of payment.',
      left,
      footerY,
      { width: contentWidth }
    );
  doc
    .fillColor(MUTED)
    .fontSize(7.5)
    .text(`Signature: ${receipt.signature}`, left, footerY + 26, { width: contentWidth });

  doc.end();
  return done;
}

function channelLabel(channel) {
  const labels = {
    transfer: 'Bank transfer',
    ussd: 'USSD',
    card: 'Card',
    pos: 'POS terminal',
    bank_branch: 'Bank branch (over the counter)',
  };
  return labels[channel] || 'Bank transfer';
}

module.exports = { renderReceiptPdf, formatWat, WAT };
