'use strict';

const paymentService = require('../../services/paymentService');
const receiptService = require('../../services/receiptService');
const { renderReceiptPdf } = require('../../services/receiptPdfService');
const { NotFoundError, ConflictError } = require('../../lib/errors');
const asyncHandler = require('../../middleware/asyncHandler');

exports.initiate = asyncHandler(async (req, res) => {
  const { transaction, feeItem, channels, virtualAccountPending } =
    await paymentService.initiatePayment({
      student: req.student,
      feeItemId: req.body.fee_item_id,
      ipAddress: req.ip,
    });

  transaction.fee_item = feeItem;

  res.status(201).json({
    payment: paymentService.serialiseTransaction(transaction, { channels }),
    // While the bank is unreachable the reference exists and the account is
    // being minted in the background (§9.4). The app shows this rather than a
    // hard failure.
    message: virtualAccountPending
      ? 'Your payment reference is being generated. We will notify you shortly.'
      : undefined,
  });
});

exports.getByReference = asyncHandler(async (req, res) => {
  const transaction = await paymentService.getPaymentForStudent(
    req.params.reference,
    req.student.student_id
  );
  res.status(200).json({ payment: paymentService.serialiseTransaction(transaction) });
});

exports.history = asyncHandler(async (req, res) => {
  const result = await paymentService.listPaymentsForStudent(req.student.student_id, {
    page: req.validatedQuery.page,
    pageSize: req.validatedQuery.page_size,
    status: req.validatedQuery.status,
  });
  res.status(200).json(result);
});

exports.receipt = asyncHandler(async (req, res) => {
  const transaction = await paymentService.getPaymentForStudent(
    req.params.reference,
    req.student.student_id
  );

  if (transaction.status !== 'Successful') {
    throw new ConflictError(
      'A receipt is only issued once a payment has settled in full',
      'receipt_not_available'
    );
  }

  const receipt = await receiptService.findForTransaction(transaction.transaction_id);
  if (!receipt) throw new NotFoundError('Receipt not found', 'receipt_not_found');

  const pdf = await renderReceiptPdf(receipt);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="UNN-Pay-Receipt-${receipt.receipt_number.replace(/\//g, '-')}.pdf"`
  );
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(pdf);
});
