'use strict';

const { resetDatabase, closeDatabase, db } = require('../helpers/setup');
const { createStudent, createFeeItem } = require('../helpers/factories');
const {
  api,
  sandbox,
  activateStudent,
  loginStudent,
  auth,
  initiatePayment,
  deliverWebhook,
  drainOutbox,
  resetAdapters,
  email,
} = require('../helpers/api');
const { toKobo } = require('../../src/lib/money');
const { runReconciliation } = require('../../src/worker/jobs/reconcile');

/**
 * The full payment lifecycle (§14, integration).
 *
 * Every scenario the specification names is exercised end to end through the
 * real HTTP surface, against real PostgreSQL, with the sandbox bank standing in
 * for GTBank.
 */

jest.setTimeout(60000);

describe('Payment lifecycle', () => {
  let student;
  let feeItem;
  let tokens;

  beforeEach(async () => {
    await resetDatabase();
    resetAdapters();

    student = await createStudent({ status: 'imported', password_hash: null });
    feeItem = await createFeeItem({ amount: '68500.00', name: 'School Fees' });

    ({ tokens } = await activateStudent(student));
  });

  afterAll(closeDatabase);

  describe('initiate to webhook to receipt — the happy path', () => {
    it('mints a reference and a virtual account, settles, and issues a receipt', async () => {
      // --- initiate ---------------------------------------------------------
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const payment = initiated.body.payment;

      expect(payment.unn_reference).toMatch(/^UNN\d{12}$/);
      expect(payment.status).toBe('Pending');
      expect(payment.expected_amount).toBe('68500.00');
      expect(payment.virtual_account_number).toMatch(/^\d{10}$/);
      expect(payment.virtual_account_bank).toBe('UNN Pay Sandbox Bank');
      // Every channel resolves to the same account and reference (§5.2).
      expect(payment.channels).toEqual(
        expect.arrayContaining(['transfer', 'ussd', 'card', 'pos', 'bank_branch'])
      );

      // The app polls this while the student pays; the channels must survive it.
      const awaiting = await api()
        .get(`/api/v1/payments/${payment.unn_reference}`)
        .set(auth(tokens))
        .expect(200);
      expect(awaiting.body.payment.channels).toEqual(payment.channels);

      // --- the student pays -------------------------------------------------
      const { webhook } = await sandbox().simulatePayment({
        unnReference: payment.unn_reference,
      });
      const [response] = await deliverWebhook(webhook);
      expect(response.status).toBe(200);

      // --- the transaction settled -----------------------------------------
      const transaction = await db.Transaction.findOne({
        where: { unn_reference: payment.unn_reference },
      });
      expect(transaction.status).toBe('Successful');
      expect(transaction.amount_paid).toBe('68500.00');
      expect(transaction.channel).toBe('transfer');
      expect(transaction.paid_at).toBeTruthy();

      // --- a receipt exists and verifies publicly ---------------------------
      const receipt = await db.Receipt.findOne({
        where: { transaction_id: transaction.transaction_id },
      });
      expect(receipt).not.toBeNull();
      expect(receipt.receipt_number).toBe('UNN/2025-2026/000001');
      expect(receipt.verification_code).toMatch(/^UNN-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      const verified = await api()
        .get(`/verify/${receipt.verification_code}`)
        .set('Accept', 'application/json')
        .expect(200);

      expect(verified.body).toMatchObject({
        valid: true,
        receipt: {
          student_name: student.full_name,
          matric_number: student.matric_number,
          amount: '68500.00',
        },
      });

      // --- the student can poll and download the PDF ------------------------
      const polled = await api()
        .get(`/api/v1/payments/${payment.unn_reference}`)
        .set(auth(tokens))
        .expect(200);
      expect(polled.body.payment.status).toBe('Successful');
      expect(polled.body.payment.receipt.receipt_number).toBe(receipt.receipt_number);

      const pdf = await api()
        .get(`/api/v1/payments/${payment.unn_reference}/receipt`)
        .set(auth(tokens))
        .expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.body.slice(0, 5).toString()).toBe('%PDF-');
      expect(pdf.body.length).toBeGreaterThan(2000);

      // --- the fee now reads as paid ---------------------------------------
      const fees = await api().get('/api/v1/fees').set(auth(tokens)).expect(200);
      const listed = fees.body.items.find((item) => item.fee_item_id === feeItem.fee_item_id);
      expect(listed.payment_status).toBe('paid');
      expect(fees.body.total_outstanding).toBe('0.00');

      // --- and the student was notified, through the outbox -----------------
      await drainOutbox();
      expect(email().lastOfKind('payment_successful', student.email)).toBeTruthy();
    });

    it('never accepts an amount from the client', async () => {
      const response = await api()
        .post('/api/v1/payments/initiate')
        .set(auth(tokens))
        .send({ fee_item_id: feeItem.fee_item_id, amount: '1.00' })
        .expect(422);

      expect(response.body.error.code).toBe('validation_error');

      // And the authoritative amount is the fee item's, always.
      const ok = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      expect(ok.body.payment.expected_amount).toBe('68500.00');
    });

    it('snapshots the amount, so a later price change does not alter a quote', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);

      await feeItem.update({ amount: '75000.00' });

      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
      });
      await deliverWebhook(webhook);

      const transaction = await db.Transaction.findOne({
        where: { unn_reference: initiated.body.payment.unn_reference },
      });
      // Paid at the quoted price, and settled, not flagged as an underpayment.
      expect(transaction.expected_amount).toBe('68500.00');
      expect(transaction.status).toBe('Successful');
    });
  });

  describe('duplicate webhook delivery (§9.1)', () => {
    it('produces exactly one receipt when the same webhook arrives three times', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const { webhook } = await sandbox().simulatePayment({ unnReference: reference });

      const responses = await deliverWebhook(webhook, { times: 3 });
      for (const response of responses) expect(response.status).toBe(200);

      const receipts = await db.Receipt.findAll();
      expect(receipts).toHaveLength(1);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Successful');
      expect(transaction.amount_paid).toBe('68500.00');

      // No spurious unapplied row from the repeats.
      expect(await db.UnappliedPayment.count()).toBe(0);

      // And exactly one success notification is queued, not three.
      const queued = await db.Outbox.findAll({ where: { event_type: 'payment.successful' } });
      expect(queued).toHaveLength(1);
    });

    it('records the replay in webhook_events rather than reprocessing it', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
      });

      await deliverWebhook(webhook, { times: 2 });

      // The identical payload is recorded once; the unique index on
      // (provider_reference, payload_hash) makes replay detection trivial.
      const events = await db.WebhookEvent.findAll();
      expect(events).toHaveLength(1);
      expect(events[0].signature_valid).toBe(true);
      expect(events[0].processing_status).toBe('processed');
    });
  });

  describe('webhook never delivered — recovered by reconciliation (§9.2)', () => {
    it('finds and applies a settlement no webhook ever announced', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      // Money arrives at the bank. No webhook is delivered at all.
      await sandbox().simulatePayment({ unnReference: reference });

      let transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Pending');

      // The sweep only considers transactions older than the grace period.
      const stats = await runReconciliation({
        now: new Date(Date.now() + 10 * 60 * 1000),
      });

      expect(stats.targeted_checked).toBeGreaterThanOrEqual(1);
      expect(stats.targeted_settled).toBe(1);

      transaction = await transaction.reload();
      expect(transaction.status).toBe('Successful');
      expect(await db.Receipt.count()).toBe(1);
    });

    it('is idempotent when it races the webhook it is compensating for', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const { webhook } = await sandbox().simulatePayment({ unnReference: reference });

      // The webhook lands, and the sweep runs anyway.
      await deliverWebhook(webhook);
      await runReconciliation({ now: new Date(Date.now() + 10 * 60 * 1000) });
      await runReconciliation({ now: new Date(Date.now() + 20 * 60 * 1000) });

      expect(await db.Receipt.count()).toBe(1);
      expect(await db.UnappliedPayment.count()).toBe(0);
    });

    it('sweeps up money paid against a reference it was never asked about', async () => {
      // A reference minted, then settled, with the transaction row's provider
      // reference never recorded — the "mint response was lost" case.
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      await db.Transaction.update(
        { virtual_account_reference: null },
        { where: { unn_reference: reference } }
      );

      await sandbox().simulatePayment({ unnReference: reference });

      const stats = await runReconciliation({ now: new Date(Date.now() + 10 * 60 * 1000) });
      expect(stats.targeted_settled + stats.swept_applied).toBeGreaterThanOrEqual(1);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Successful');
    });
  });

  describe('expired reference (§6, §10)', () => {
    it('expires a stale pending reference and releases the virtual account', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      await db.Transaction.update(
        { expires_at: new Date(Date.now() - 1000) },
        { where: { unn_reference: reference } }
      );

      const { expireStaleTransactions } = require('../../src/worker/jobs/dailyMaintenance');
      const result = await expireStaleTransactions();

      expect(result.expired).toBe(1);
      expect(result.released).toBe(1);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Expired');
      expect(transaction.virtual_account_released_at).toBeTruthy();

      const account = await db.SandboxVirtualAccount.findOne({
        where: { unn_reference: reference },
      });
      expect(account.released_at).toBeTruthy();
    });

    it('opens an unapplied payment when money arrives against an expired reference', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      await db.Transaction.update(
        { status: 'Expired', expires_at: new Date(Date.now() - 1000) },
        { where: { unn_reference: reference } }
      );

      const { webhook } = await sandbox().simulatePayment({ unnReference: reference });
      await deliverWebhook(webhook);

      const unapplied = await db.UnappliedPayment.findOne();
      expect(unapplied.reason).toBe('expired_reference');
      expect(unapplied.status).toBe('open');
      expect(unapplied.amount_received).toBe('68500.00');

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('UnderReview');

      // No receipt is issued (§10.1).
      expect(await db.Receipt.count()).toBe(0);
    });

    it('rejects an initiate for a fee whose payment is under review', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      await db.Transaction.update(
        { status: 'UnderReview' },
        { where: { unn_reference: initiated.body.payment.unn_reference } }
      );

      const blocked = await initiatePayment(tokens, feeItem.fee_item_id).expect(409);
      expect(blocked.body.error.code).toBe('fee_under_review');
    });
  });

  describe('amount mismatches (§10)', () => {
    it.each([
      ['underpayment', '60000.00', '-8500.00'],
      ['overpayment', '70000.00', '1500.00'],
    ])('opens an unapplied row for an %s and issues no receipt', async (reason, paid, variance) => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const { webhook } = await sandbox().simulatePayment({
        unnReference: reference,
        amountKobo: toKobo(paid),
      });
      const [response] = await deliverWebhook(webhook);
      expect(response.status).toBe(200);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('UnderReview');
      expect(transaction.amount_paid).toBe(paid);

      expect(await db.Receipt.count()).toBe(0);

      const unapplied = await db.UnappliedPayment.findOne();
      expect(unapplied).toMatchObject({
        reason,
        status: 'open',
        amount_received: paid,
        amount_expected: '68500.00',
        variance,
        student_id: student.student_id,
      });

      // The deadline is exactly 90 days from payment (§10.2).
      const days = Math.round(
        (new Date(unapplied.deadline_at) - new Date(transaction.paid_at)) / (24 * 60 * 60 * 1000)
      );
      expect(days).toBe(90);
    });

    it('notifies both the student and Bursary with the exact figures', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
        amountKobo: toKobo('60000.00'),
      });
      await deliverWebhook(webhook);
      await drainOutbox();

      const toStudent = email().lastOfKind('unapplied_payment', student.email);
      expect(toStudent).toBeTruthy();
      expect(toStudent.text).toContain('60000.00');
      expect(toStudent.text).toContain('68500.00');
      expect(toStudent.text).toContain('Please visit the Bursary before');

      const toBursary = email().lastOfKind('bursary_alert');
      expect(toBursary).toBeTruthy();
      expect(toBursary.text).toContain('underpayment');
    });
  });

  describe('unknown reference (§10)', () => {
    it('records money quoting a reference UNN never minted, attached to no student', async () => {
      const { webhook } = await sandbox().simulatePayment({
        unnReference: 'UNN259900000018',
        amountKobo: toKobo('50000.00'),
      });
      const [response] = await deliverWebhook(webhook);
      expect(response.status).toBe(200);

      const unapplied = await db.UnappliedPayment.findOne();
      expect(unapplied).toMatchObject({
        reason: 'unknown_reference',
        status: 'open',
        amount_received: '50000.00',
        transaction_id: null,
        student_id: null,
        amount_expected: null,
      });

      // Bursary still hears about it, even though no student can be notified.
      await drainOutbox();
      expect(email().lastOfKind('bursary_alert')).toBeTruthy();
    });
  });

  describe('second payment against a settled reference (§10)', () => {
    it('records it as a duplicate rather than issuing a second receipt', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const first = await sandbox().simulatePayment({ unnReference: reference });
      await deliverWebhook(first.webhook);

      // A genuinely different settlement, for the same reference.
      const second = await sandbox().simulatePayment({ unnReference: reference });
      await deliverWebhook(second.webhook);

      expect(await db.Receipt.count()).toBe(1);

      const unapplied = await db.UnappliedPayment.findOne();
      expect(unapplied.reason).toBe('duplicate_payment');
      expect(unapplied.provider_reference).toBe(second.settlement.providerReference);
    });
  });

  describe('failed settlements', () => {
    it('marks the transaction Failed without opening an unapplied row', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const { webhook } = await sandbox().simulatePayment({
        unnReference: reference,
        status: 'failed',
      });
      await deliverWebhook(webhook);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Failed');
      expect(await db.UnappliedPayment.count()).toBe(0);
      expect(await db.Receipt.count()).toBe(0);
    });

    it('ignores a settlement the bank still reports as pending', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const { webhook } = await sandbox().simulatePayment({
        unnReference: reference,
        status: 'pending',
      });
      await deliverWebhook(webhook);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Pending');
    });
  });

  describe('double payment guard (§7.4)', () => {
    it('refuses a second initiate once the fee is paid', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
      });
      await deliverWebhook(webhook);

      const blocked = await initiatePayment(tokens, feeItem.fee_item_id).expect(409);
      expect(blocked.body.error.code).toBe('fee_already_paid');
    });

    it('is enforced by the database, not only by the application check', async () => {
      const first = await db.Transaction.create({
        unn_reference: 'UNN250900000015',
        student_id: student.student_id,
        fee_item_id: feeItem.fee_item_id,
        expected_amount: '68500.00',
        status: 'Successful',
        expires_at: new Date(Date.now() + 3600000),
      });
      expect(first.transaction_id).toBeTruthy();

      // The partial unique index refuses a second Successful row for the same
      // (student, fee item), whatever the application layer believes.
      const rejection = await db.Transaction.create({
        unn_reference: 'UNN250900000023',
        student_id: student.student_id,
        fee_item_id: feeItem.fee_item_id,
        expected_amount: '68500.00',
        status: 'Successful',
        expires_at: new Date(Date.now() + 3600000),
      }).catch((error) => error);

      expect(rejection).toBeInstanceOf(db.Sequelize.UniqueConstraintError);
      expect(rejection.parent.constraint).toBe('uniq_successful_payment_per_fee_item');

      // Non successful rows are unaffected: a student may retry freely.
      await expect(
        db.Transaction.create({
          unn_reference: 'UNN250900000031',
          student_id: student.student_id,
          fee_item_id: feeItem.fee_item_id,
          expected_amount: '68500.00',
          status: 'Pending',
          expires_at: new Date(Date.now() + 3600000),
        })
      ).resolves.toBeTruthy();
    });
  });

  describe('idempotency keys (§9.1)', () => {
    it('returns the original response instead of minting a second reference', async () => {
      const key = 'idem-key-lifecycle-001';

      const first = await initiatePayment(tokens, feeItem.fee_item_id, {
        'Idempotency-Key': key,
      }).expect(201);

      const replay = await initiatePayment(tokens, feeItem.fee_item_id, {
        'Idempotency-Key': key,
      }).expect(201);

      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body.payment.unn_reference).toBe(first.body.payment.unn_reference);
      expect(await db.Transaction.count()).toBe(1);
    });

    it('rejects a key reused with a different body', async () => {
      const other = await createFeeItem({ name: 'Hostel', amount: '18000.00' });
      const key = 'idem-key-lifecycle-002';

      await initiatePayment(tokens, feeItem.fee_item_id, { 'Idempotency-Key': key }).expect(201);

      const conflict = await initiatePayment(tokens, other.fee_item_id, {
        'Idempotency-Key': key,
      }).expect(409);

      expect(conflict.body.error.code).toBe('idempotency_key_reused');
    });

    it('scopes keys per student, so two students may use the same key', async () => {
      const otherStudent = await createStudent({ status: 'active' });
      const otherTokens = await loginStudent(otherStudent);
      const key = 'shared-key';

      await initiatePayment(tokens, feeItem.fee_item_id, { 'Idempotency-Key': key }).expect(201);
      await initiatePayment(otherTokens, feeItem.fee_item_id, {
        'Idempotency-Key': key,
      }).expect(201);

      expect(await db.Transaction.count()).toBe(2);
    });
  });
});
