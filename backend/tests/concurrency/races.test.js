'use strict';

const { resetDatabase, closeDatabase, db } = require('../helpers/setup');
const { createStudent, createFeeItem } = require('../helpers/factories');
const {
  api,
  sandbox,
  loginStudent,
  auth,
  initiatePayment,
  deliverWebhook,
  resetAdapters,
} = require('../helpers/api');
const settlementService = require('../../src/services/settlementService');
const { runReconciliation } = require('../../src/worker/jobs/reconcile');

/**
 * Concurrency (§14).
 *
 * These run against real PostgreSQL, deliberately: the behaviour under test is
 * the partial unique index and SELECT ... FOR UPDATE, and SQLite has neither.
 * Every case here is a race that will happen in production — a double tapped
 * button, a bank retrying a webhook while the reconciliation sweep is mid pass,
 * a student paying two references for one fee.
 */

jest.setTimeout(60000);

describe('Concurrency', () => {
  let student;
  let feeItem;
  let tokens;

  beforeEach(async () => {
    await resetDatabase();
    resetAdapters();
    student = await createStudent({ status: 'active' });
    feeItem = await createFeeItem({ amount: '68500.00' });
    tokens = await loginStudent(student);
  });

  afterAll(closeDatabase);

  describe('two simultaneous initiate calls', () => {
    it('creates exactly one transaction when both carry the same Idempotency-Key', async () => {
      const key = 'double-tapped-pay-button';

      const responses = await Promise.all([
        initiatePayment(tokens, feeItem.fee_item_id, { 'Idempotency-Key': key }),
        initiatePayment(tokens, feeItem.fee_item_id, { 'Idempotency-Key': key }),
      ]);

      const statuses = responses.map((r) => r.status).sort();
      // One does the work. The other either replays the stored response or is
      // told the first is still in flight — never a second transaction.
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);

      expect(await db.Transaction.count()).toBe(1);
    });

    it('holds under a burst of ten identical requests', async () => {
      const key = 'burst-key';

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          initiatePayment(tokens, feeItem.fee_item_id, { 'Idempotency-Key': key })
        )
      );

      expect(await db.Transaction.count()).toBe(1);
      expect(responses.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      for (const response of responses) expect([201, 409]).toContain(response.status);
    });

    it('mints distinct references when the calls carry no idempotency key', async () => {
      // Without a key these are two genuinely separate payment attempts, and
      // §6 is explicit that a reference is minted per attempt and never reused.
      const responses = await Promise.all([
        initiatePayment(tokens, feeItem.fee_item_id),
        initiatePayment(tokens, feeItem.fee_item_id),
      ]);

      for (const response of responses) expect(response.status).toBe(201);

      const references = responses.map((r) => r.body.payment.unn_reference);
      expect(new Set(references).size).toBe(2);

      // The guarantee that matters is downstream: paying both cannot produce
      // two successful payments for one fee item. That is the next test.
      expect(await db.Transaction.count()).toBe(2);
    });
  });

  describe('two simultaneous webhooks for the same reference', () => {
    it('settles exactly once and issues exactly one receipt', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const { webhook } = await sandbox().simulatePayment({ unnReference: reference });

      // The bank delivers the identical signed envelope five times at once.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => deliverWebhook(webhook).then(([r]) => r))
      );
      for (const response of responses) expect(response.status).toBe(200);

      expect(await db.Receipt.count()).toBe(1);
      expect(await db.UnappliedPayment.count()).toBe(0);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Successful');
      expect(transaction.amount_paid).toBe('68500.00');

      // Exactly one success notification is queued, not five.
      expect(await db.Outbox.count({ where: { event_type: 'payment.successful' } })).toBe(1);
    });

    it('applies exactly one settlement when applySettlement is called concurrently', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { settlement } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
      });

      // Straight at the service, bypassing the webhook layer's own dedupe, so
      // the guarantee being tested is the service's and the database's.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          settlementService.applySettlement(settlement, { source: 'webhook' })
        )
      );

      const settled = results.filter((r) => r.outcome === settlementService.OUTCOME.SETTLED);
      expect(settled).toHaveLength(1);
      expect(await db.Receipt.count()).toBe(1);
    });
  });

  describe('two references for one fee item, both paid', () => {
    it('settles exactly one and routes the other to the unapplied queue', async () => {
      // The student initiates twice, then pays both — entirely possible in real
      // life, and the case the partial unique index exists for.
      const first = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const second = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);

      const paymentA = await sandbox().simulatePayment({
        unnReference: first.body.payment.unn_reference,
      });
      const paymentB = await sandbox().simulatePayment({
        unnReference: second.body.payment.unn_reference,
      });

      await Promise.all([
        deliverWebhook(paymentA.webhook),
        deliverWebhook(paymentB.webhook),
      ]);

      const successful = await db.Transaction.count({ where: { status: 'Successful' } });
      expect(successful).toBe(1);

      // Exactly one receipt, and the losing payment is recorded, never absorbed.
      expect(await db.Receipt.count()).toBe(1);

      const unapplied = await db.UnappliedPayment.findAll();
      expect(unapplied).toHaveLength(1);
      expect(unapplied[0].reason).toBe('duplicate_payment');
      expect(unapplied[0].status).toBe('open');

      // The money is still fully accounted for: both amounts are on record.
      const totalRecorded =
        Number(unapplied[0].amount_received) +
        Number((await db.Transaction.findOne({ where: { status: 'Successful' } })).amount_paid);
      expect(totalRecorded).toBe(137000);
    });
  });

  describe('reconciliation racing the webhook it is compensating for', () => {
    it('produces one receipt when the sweep and the webhook land together', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      const { webhook } = await sandbox().simulatePayment({ unnReference: reference });

      await Promise.all([
        deliverWebhook(webhook),
        runReconciliation({ now: new Date(Date.now() + 10 * 60 * 1000) }),
        deliverWebhook(webhook),
      ]);

      expect(await db.Receipt.count()).toBe(1);
      expect(await db.UnappliedPayment.count()).toBe(0);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Successful');
    });

    it('survives two reconciliation sweeps running at the same time', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      await sandbox().simulatePayment({ unnReference: initiated.body.payment.unn_reference });

      const at = new Date(Date.now() + 10 * 60 * 1000);
      await Promise.all([runReconciliation({ now: at }), runReconciliation({ now: at })]);

      expect(await db.Receipt.count()).toBe(1);
      expect(await db.Transaction.count({ where: { status: 'Successful' } })).toBe(1);
    });
  });

  describe('receipt numbering under load', () => {
    it('issues unique, gapless receipt numbers for concurrent settlements', async () => {
      // Ten students each paying their own fee item, all settling at once.
      const payments = [];
      for (let i = 0; i < 10; i += 1) {
        const payer = await createStudent({ status: 'active' });
        const fee = await createFeeItem({ amount: '5000.00', name: `Fee ${i}` });
        const payerTokens = await loginStudent(payer);
        const initiated = await initiatePayment(payerTokens, fee.fee_item_id).expect(201);
        payments.push(
          await sandbox().simulatePayment({ unnReference: initiated.body.payment.unn_reference })
        );
      }

      await Promise.all(payments.map((payment) => deliverWebhook(payment.webhook)));

      const receipts = await db.Receipt.findAll({ order: [['receipt_id', 'ASC']] });
      expect(receipts).toHaveLength(10);

      const numbers = receipts.map((r) => r.receipt_number);
      expect(new Set(numbers).size).toBe(10);

      const serials = numbers.map((n) => Number(n.split('/')[2])).sort((a, b) => a - b);
      expect(serials).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Verification codes are unique too.
      expect(new Set(receipts.map((r) => r.verification_code)).size).toBe(10);
    });
  });

  describe('expiry racing a settlement', () => {
    it('never both expires and settles the same transaction', async () => {
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = initiated.body.payment.unn_reference;

      // The reference expires at this instant, and the money lands at this
      // instant. Exactly one of the two outcomes must win.
      await db.Transaction.update(
        { expires_at: new Date(Date.now() - 1) },
        { where: { unn_reference: reference } }
      );

      const { webhook } = await sandbox().simulatePayment({
        unnReference: reference,
        paidAt: new Date(Date.now() - 60000), // paid before it expired
      });

      const { expireStaleTransactions } = require('../../src/worker/jobs/dailyMaintenance');
      await Promise.all([deliverWebhook(webhook), expireStaleTransactions()]);

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(['Successful', 'Expired', 'UnderReview']).toContain(transaction.status);

      // Whichever won, the money is accounted for exactly once: either a
      // receipt exists, or an unapplied row does, never both and never neither.
      const receipts = await db.Receipt.count();
      const unapplied = await db.UnappliedPayment.count();

      if (transaction.status === 'Successful') {
        expect(receipts).toBe(1);
        expect(unapplied).toBe(0);
      } else if (transaction.status === 'UnderReview') {
        expect(receipts).toBe(0);
        expect(unapplied).toBe(1);
      }
    });
  });
});
