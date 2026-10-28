'use strict';

const { stringify } = require('csv-stringify/sync');
const PDFDocument = require('pdfkit');
const { DateTime } = require('luxon');
const { toKobo, formatNaira } = require('../../lib/money');
const { registerFonts, SANS, SANS_BOLD } = require('../../lib/pdfFonts');

/**
 * Transaction export, CSV and PDF (§11.6).
 *
 * Times are rendered in West Africa Time here, at the presentation layer, from
 * the UTC values the database holds (§3.1). A Bursary officer reconciling
 * against a bank statement is working in local time, not UTC.
 */

const WAT = 'Africa/Lagos';

const wat = (value) =>
  value ? DateTime.fromJSDate(new Date(value)).setZone(WAT).toFormat('yyyy-LL-dd HH:mm:ss') : '';

const COLUMNS = [
  ['unn_reference', 'UNN Reference'],
  ['matric_number', 'Matric Number'],
  ['student_name', 'Student'],
  ['department', 'Department'],
  ['level', 'Level'],
  ['fee_item', 'Fee Item'],
  ['category', 'Category'],
  ['session', 'Session'],
  ['expected_amount', 'Expected (NGN)'],
  ['amount_paid', 'Paid (NGN)'],
  ['status', 'Status'],
  ['channel', 'Channel'],
  ['receipt_number', 'Receipt Number'],
  ['paid_at', 'Paid At (WAT)'],
  ['created_at', 'Initiated At (WAT)'],
];

function toFlatRow(item) {
  return {
    unn_reference: item.unn_reference,
    matric_number: item.student ? item.student.matric_number : '',
    student_name: item.student ? item.student.full_name : '',
    department: item.student ? item.student.department : '',
    level: item.student ? item.student.level : '',
    fee_item: item.fee_item ? item.fee_item.name : '',
    category: item.fee_item ? item.fee_item.category : '',
    session: item.fee_item ? item.fee_item.session : '',
    expected_amount: item.expected_amount,
    amount_paid: item.amount_paid || '',
    status: item.status,
    channel: item.channel || '',
    receipt_number: item.receipt_number || '',
    paid_at: wat(item.paid_at),
    created_at: wat(item.created_at),
  };
}

function toCsv(items) {
  return stringify(items.map(toFlatRow), {
    header: true,
    columns: COLUMNS.map(([key, header]) => ({ key, header })),
  });
}

/**
 * A landscape summary report. Deliberately a report, not a dump: it carries the
 * filters that produced it and the totals, so a printed copy is self describing.
 */
async function toPdf(items, { filters = {}, generatedBy } = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 32,
    info: { Title: 'UNN Pay Transaction Report', Author: 'University of Nigeria, Nsukka' },
  });
  registerFonts(doc);

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - left - doc.page.margins.right;

  const collectedKobo = items
    .filter((item) => item.status === 'Successful')
    .reduce((sum, item) => sum + toKobo(item.amount_paid || '0'), 0);

  // --- header ---------------------------------------------------------------
  doc.fillColor('#0B6E4F').font(SANS_BOLD).fontSize(15)
    .text('UNIVERSITY OF NIGERIA, NSUKKA — Transaction Report', left, 30);
  doc.fillColor('#6B7280').font(SANS).fontSize(8.5)
    .text(
      `Generated ${wat(new Date())} WAT${generatedBy ? ` by ${generatedBy}` : ''}  ·  ` +
        `${items.length} transaction${items.length === 1 ? '' : 's'}  ·  ` +
        `Collected: ${formatNaira(collectedKobo)}`,
      left,
      50
    );

  const filterText = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
    .join('   ·   ');
  doc.text(filterText ? `Filters — ${filterText}` : 'Filters — none (all transactions)', left, 62);

  // --- table ----------------------------------------------------------------
  // Sums to 776pt, inside the 778pt between landscape A4 margins.
  const widths = [82, 54, 104, 100, 22, 146, 58, 58, 60, 92];
  const rightAligned = new Set([6, 7]);
  const cellOptions = (index) => ({
    width: widths[index] - 6,
    align: rightAligned.has(index) ? 'right' : 'left',
  });
  const cellPadding = 3.5;
  const headers = [
    'Reference',
    'Matric',
    'Student',
    'Department',
    'Lvl',
    'Fee item',
    'Expected',
    'Paid',
    'Status',
    'Paid at',
  ];

  let y = 84;

  const drawHeader = () => {
    doc.rect(left, y, contentWidth, 18).fill('#F3F4F6');
    doc.fillColor('#374151').font(SANS_BOLD).fontSize(7.5);
    let x = left + 4;
    headers.forEach((header, index) => {
      doc.text(header, x, y + 5.5, { ...cellOptions(index), ellipsis: true });
      x += widths[index];
    });
    y += 18;
  };

  drawHeader();

  for (const item of items) {
    const row = toFlatRow(item);
    const cells = [
      row.unn_reference,
      row.matric_number,
      row.student_name,
      row.department,
      row.level,
      row.fee_item,
      row.expected_amount,
      row.amount_paid,
      row.status,
      row.paid_at,
    ].map((cell) => String(cell ?? ''));

    // A row is as tall as its tallest cell. A fixed height let long fee names
    // and timestamps wrap into the row below.
    doc.font(SANS).fontSize(7);
    const rowHeight =
      Math.max(...cells.map((cell, index) => doc.heightOfString(cell, cellOptions(index)))) +
      cellPadding * 2;

    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 32 });
      y = 36;
      drawHeader();
      doc.font(SANS).fontSize(7);
    }

    doc.fillColor(row.status === 'Successful' ? '#111827' : '#9A3412');
    let x = left + 4;
    cells.forEach((cell, index) => {
      doc.text(cell, x, y + cellPadding, cellOptions(index));
      x += widths[index];
    });

    y += rowHeight;
    doc.moveTo(left, y).lineTo(left + contentWidth, y).strokeColor('#E5E7EB').lineWidth(0.4).stroke();
  }

  doc.end();
  return done;
}

module.exports = { toCsv, toPdf, toFlatRow, COLUMNS };
