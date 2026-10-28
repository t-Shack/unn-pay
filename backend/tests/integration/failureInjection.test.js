'use strict';

const { resetDatabase, closeDatabase, db } = require('../helpers/setup');
const { createStudent, createFeeItem } = require('../helpers/factories');
const {
  api,
  sandbox,
  resilient,
  loginStudent,
  auth,
  initiatePayment,
  deliverWebhook,
  drainOutbox,
  resetAdapters,
} = require('../helpers/api');
const outboxService = require('../../src/services/outboxService');
const notificationService = require('../../src/services/notificationService');
const { runOutboxDrain } = require('../../src/worker/jobs/outboxDrain');
const { runReconciliation } = require('../../src/worker/jobs/reconcile');

/**
 * Failure injection (§14).
 *
 * The bank times out, returns malformed payloads, and returns 500s. The circuit
 * breaker must open, requests must queue rather than being rejected, and no
 * failure of an external service may ever cost a payment.
 */

jest.setTimeout(60000);

describe('Failure injection', () => {
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

  describe('the bank fails while minting a virtual account', () => {
    it('still mints the reference, and queues the account rather than rejecting (§9.4)', async () => {
      sandbox().injectFault('mintVirtualAccount', 'error');

      const response = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);

      // The student gets a reference and a clear message, not a hard error.
      expect(response.body.payment.unn_reference).toMatch(/^UNN\d{12}$/);
      expect(response.body.payment.virtual_account_number).toBeNull();
      expect(response.body.payment.virtual_account_pending).toBe(true);
      expect(response.body.message).toBe(
        'Your payment reference is being generated. We will notify you shortly.'
      );

      // The work is queued for the worker.
      const queued = await db.Outbox.findOne({
        where: { event_type: 'payment.mint_virtual_account' },
      });
      expect(queued).toBeTruthy();
      expect(queued.payload.transaction_id).toBeTruthy();
    });

    it('completes the queued mint once the bank recovers', async () => {
      sandbox().injectFault('mintVirtualAccount', 'error');
      const response = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = response.body.payment.unn_reference;

      // The bank comes back, and the worker finishes the job.
      sandbox().clearFaults();
      resilient().breaker.reset();
      await runOutboxDrain();

      const transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.virtual_account_number).toMatch(/^\d{10}$/);
      expect(transaction.virtual_account_bank).toBe('UNN Pay Sandbox Bank');

      // And the student can now be paid against normally.
      const { webhook } = await sandbox().simulatePayment({ unnReference: reference });
      await deliverWebhook(webhook);
      expect(await db.Receipt.count()).toBe(1);
    });

    it('opens the circuit after five consecutive failures and then fails fast', async () => {
      sandbox().injectFault('mintVirtualAccount', 'error', { times: 10 });

      for (let i = 0; i < 5; i += 1) {
        const fee = await createFeeItem({ name: `Fee ${i}`, amount: '1000.00' });
        await initiatePayment(tokens, fee.fee_item_id).expect(201);
      }

      const circuit = resilient().circuitSnapshot();
      expect(circuit.state).toBe('open');
      expect(circuit.consecutive_failures).toBeGreaterThanOrEqual(5);

      // While open the adapter is not called at all: the remaining injected
      // faults are still queued, unconsumed.
      const faultsBefore = sandbox()._faults.length;
      const fee = await createFeeItem({ name: 'After open', amount: '1000.00' });
      const response = await initiatePayment(tokens, fee.fee_item_id).expect(201);

      expect(response.body.payment.virtual_account_pending).toBe(true);
      expect(sandbox()._faults.length).toBe(faultsBefore);
    });

    it('treats a timeout the same as a failure', async () => {
      sandbox().injectFault('mintVirtualAccount', 'timeout');
      const response = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      expect(response.body.payment.virtual_account_pending).toBe(true);
      expect(resilient().circuitSnapshot().consecutive_failures).toBe(1);
    });

    it('rejects a malformed response rather than storing nonsense', async () => {
      sandbox().injectFault('mintVirtualAccount', 'malformed');

      const response = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);

      // The contract check caught it, so nothing bogus reached the database.
      const transaction = await db.Transaction.findOne({
        where: { unn_reference: response.body.payment.unn_reference },
      });
      expect(transaction.virtual_account_number).toBeNull();
      expect(transaction.virtual_account_bank).toBeNull();
      expect(response.body.payment.virtual_account_pending).toBe(true);
    });
  });

  describe('the bank fails during reconciliation', () => {
    it('records the error and leaves the transaction untouched for the next sweep', async () => {
      const response = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const reference = response.body.payment.unn_reference;
      await sandbox().simulatePayment({ unnReference: reference });

      sandbox().injectFault('fetchSettlement', 'error', { times: 5 });
      sandbox().injectFault('listSettlements', 'error', { times: 5 });

      const stats = await runReconciliation({ now: new Date(Date.now() + 10 * 60 * 1000) });
      expect(stats.errors).toBeGreaterThan(0);

      let transaction = await db.Transaction.findOne({ where: { unn_reference: reference } });
      expect(transaction.status).toBe('Pending');

      // The next sweep, with the bank healthy, recovers it.
      sandbox().clearFaults();
      resilient().breaker.reset();
      await runReconciliation({ now: new Date(Date.now() + 20 * 60 * 1000) });

      transaction = await transaction.reload();
      expect(transaction.status).toBe('Successful');
    });
  });

  describe('the notification provider fails', () => {
    it('never rolls back a settled payment', async () => {
      const response = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: response.body.payment.unn_reference,
      });
      await deliverWebhook(webhook);

      // Every delivery attempt fails, permanently.
      const spy = jest
        .spyOn(notificationService, 'dispatch')
        .mockRejectedValue(new Error('email provider is down'));

      try {
        await runOutboxDrain();

        // The payment is untouched: settled, with its receipt.
        const transaction = await db.Transaction.findOne({
          where: { unn_reference: response.body.payment.unn_reference },
        });
        expect(transaction.status).toBe('Successful');
        expect(await db.Receipt.count()).toBe(1);

        // The notification is queued for retry, not lost.
        const entry = await db.Outbox.findOne({ where: { event_type: 'payment.successful' } });
        expect(entry.status).toBe('pending');
        expect(entry.attempt_count).toBe(1);
        expect(entry.last_error).toContain('email provider is down');
        expect(new Date(entry.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      } finally {
        spy.mockRestore();
      }
    });

    it('marks an entry dead after 8 attempts and surfaces it to the dashboard', async () => {
      await outboxService.enqueue('payment.successful', { student_id: student.student_id });

      const spy = jest
        .spyOn(notificationService, 'dispatch')
        .mockRejectedValue(new Error('permanently broken'));

      try {
        // Drive all eight attempts, moving the clock past each backoff. The
        // step must clear the longest possible wait: 6 hours plus 20% jitter.
        const stepMs = 8 * 60 * 60 * 1000;
        for (let attempt = 1; attempt <= 8; attempt += 1) {
          await runOutboxDrain({ now: new Date(Date.now() + attempt * stepMs) });
        }

        const entry = await db.Outbox.findOne({ where: { event_type: 'payment.successful' } });
        expect(entry.status).toBe('dead');
        expect(entry.attempt_count).toBe(8);

        const stats = await outboxService.stats();
        expect(stats.dead).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('recovers entries a crashed worker left claimed', async () => {
      await outboxService.enqueue('payment.successful', { student_id: student.student_id });

      // Simulate a worker that claimed the entry and then died.
      await db.Outbox.update(
        { status: 'processing', locked_at: new Date(Date.now() - 20 * 60 * 1000) },
        { where: {} }
      );

      const recovered = await outboxService.recoverStalled();
      expect(recovered).toBe(1);

      const entry = await db.Outbox.findOne();
      expect(entry.status).toBe('pending');
    });
  });

  describe('malformed and hostile webhook bodies', () => {
    it('stores the raw body when parsing fails, and still answers 200', async () => {
      const crypto = require('crypto');
      const body = '{"this is not":"a settlement"';
      const t = Math.floor(Date.now() / 1000);
      const signature = crypto
        .createHmac('sha256', process.env.BANK_WEBHOOK_SECRET)
        .update(`${t}.${body}`, 'utf8')
        .digest('hex');

      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('x-bank-signature', `t=${t},v1=${signature}`)
        .set('Content-Type', 'application/json')
        .send(body);

      // 200, because a 500 invites the bank to hammer us (§9.5).
      expect(response.status).toBe(200);
      expect(response.body.outcome).toBe('failed');

      // The evidence survived the parse failure.
      const event = await db.WebhookEvent.findOne();
      expect(event.raw_body).toBe(body);
      expect(event.signature_valid).toBe(true);
      expect(event.processing_status).toBe('failed');
      expect(event.error_detail).toBeTruthy();
    });

    it('rejects an unsigned body before writing anything at all', async () => {
      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('Content-Type', 'application/json')
        .send('{"provider_reference":"forged"}');

      expect(response.status).toBe(401);
      // Nothing was written: an unauthenticated caller cannot fill our tables.
      expect(await db.WebhookEvent.count()).toBe(0);
    });
  });

  describe('database level failure', () => {
    it('reports not ready when the database is unreachable', async () => {
      const spy = jest
        .spyOn(db.sequelize, 'query')
        .mockRejectedValueOnce(new Error('connection refused'));

      try {
        const response = await api().get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body.status).toBe('not_ready');
        expect(response.body.checks.database.ok).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('reports liveness regardless, so a database blip does not trigger a restart', async () => {
      const response = await api().get('/health').expect(200);
      expect(response.body.status).toBe('ok');
    });
  });
});
