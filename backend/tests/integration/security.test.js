'use strict';

const crypto = require('crypto');
const { resetDatabase, closeDatabase, db } = require('../helpers/setup');
const { createStudent, createFeeItem, createAdmin } = require('../helpers/factories');
const {
  api,
  sandbox,
  loginStudent,
  loginAdmin,
  auth,
  initiatePayment,
  deliverWebhook,
  resetAdapters,
} = require('../helpers/api');
const tokenService = require('../../src/services/tokenService');

/**
 * Security (§13, §14).
 *
 * Every case the specification names, plus the ones that matter most in a
 * financial system: one student must never be able to see another's money, and
 * a receipt must never verify once it has been altered.
 */

jest.setTimeout(60000);

describe('Security', () => {
  beforeEach(async () => {
    await resetDatabase();
    resetAdapters();
  });

  afterAll(closeDatabase);

  describe('webhook signatures (§9.5, §13.4)', () => {
    const signedRequest = (body, { secret = process.env.BANK_WEBHOOK_SECRET, timestamp } = {}) => {
      const t = timestamp || Math.floor(Date.now() / 1000);
      const signature = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
      return { t, signature };
    };

    const body = JSON.stringify({
      event: 'settlement.completed',
      provider_reference: 'SBX-FORGED-0001',
      unn_reference: 'UNN250900000015',
      amount_paid: '68500.00',
      currency: 'NGN',
      channel: 'transfer',
      status: 'successful',
      paid_at: new Date().toISOString(),
    });

    it('rejects a request with no signature at all', async () => {
      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(await db.WebhookEvent.count()).toBe(0);
    });

    it('rejects a signature made with the wrong secret', async () => {
      const { t, signature } = signedRequest(body, { secret: 'the-attackers-guess' });

      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('x-bank-signature', `t=${t},v1=${signature}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
      expect(await db.WebhookEvent.count()).toBe(0);
    });

    it('rejects a body altered after signing — one changed digit is enough', async () => {
      const { t, signature } = signedRequest(body);
      const tampered = body.replace('68500.00', '99999.00');

      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('x-bank-signature', `t=${t},v1=${signature}`)
        .set('Content-Type', 'application/json')
        .send(tampered);

      expect(response.status).toBe(401);
    });

    it.each([
      ['ten minutes old', -600],
      ['ten minutes in the future', 600],
    ])('rejects a replayed timestamp %s (§9.5)', async (_label, offsetSeconds) => {
      const stale = Math.floor(Date.now() / 1000) + offsetSeconds;
      const { signature } = signedRequest(body, { timestamp: stale });

      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('x-bank-signature', `t=${stale},v1=${signature}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
    });

    it('accepts a timestamp inside the five minute window', async () => {
      const recent = Math.floor(Date.now() / 1000) - 120;
      const { signature } = signedRequest(body, { timestamp: recent });

      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('x-bank-signature', `t=${recent},v1=${signature}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(200);
    });

    it.each([
      ['malformed header', 'not-a-signature'],
      ['missing v1', 't=1700000000'],
      ['missing t', 'v1=abcdef'],
      ['non numeric timestamp', 't=yesterday,v1=abcdef'],
    ])('rejects a %s', async (_label, header) => {
      const response = await api()
        .post('/api/v1/webhooks/bank')
        .set('x-bank-signature', header)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(401);
    });
  });

  describe('cross student access (§14)', () => {
    it('student A cannot read student B\'s transaction', async () => {
      const alice = await createStudent({ status: 'active' });
      const bob = await createStudent({ status: 'active' });
      const feeItem = await createFeeItem({});

      const bobTokens = await loginStudent(bob);
      const bobPayment = await initiatePayment(bobTokens, feeItem.fee_item_id).expect(201);

      const aliceTokens = await loginStudent(alice);
      const response = await api()
        .get(`/api/v1/payments/${bobPayment.body.payment.unn_reference}`)
        .set(auth(aliceTokens));

      // 404, not 403: a different answer would confirm the reference exists.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('payment_not_found');
    });

    it('student A cannot download student B\'s receipt', async () => {
      const alice = await createStudent({ status: 'active' });
      const bob = await createStudent({ status: 'active' });
      const feeItem = await createFeeItem({});

      const bobTokens = await loginStudent(bob);
      const bobPayment = await initiatePayment(bobTokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: bobPayment.body.payment.unn_reference,
      });
      await deliverWebhook(webhook);

      const aliceTokens = await loginStudent(alice);
      await api()
        .get(`/api/v1/payments/${bobPayment.body.payment.unn_reference}/receipt`)
        .set(auth(aliceTokens))
        .expect(404);
    });

    it('history only ever returns the caller\'s own payments', async () => {
      const alice = await createStudent({ status: 'active' });
      const bob = await createStudent({ status: 'active' });
      const feeItem = await createFeeItem({});

      await initiatePayment(await loginStudent(bob), feeItem.fee_item_id).expect(201);
      const aliceTokens = await loginStudent(alice);
      await initiatePayment(aliceTokens, feeItem.fee_item_id).expect(201);

      const response = await api()
        .get('/api/v1/payments/history')
        .set(auth(aliceTokens))
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(await db.Transaction.count()).toBe(2);
    });
  });

  describe('tokens (§13.3)', () => {
    let student;
    let tokens;

    beforeEach(async () => {
      student = await createStudent({ status: 'active' });
      tokens = await loginStudent(student);
    });

    it('rejects a request with no token', async () => {
      const response = await api().get('/api/v1/fees').expect(401);
      expect(response.body.error.code).toBe('missing_token');
    });

    it.each([
      ['garbage', 'not-a-jwt'],
      ['a token signed with the wrong secret', null],
    ])('rejects %s', async (_label, value) => {
      const token =
        value ||
        require('jsonwebtoken').sign({ sub: '1', typ: 'student' }, 'the-wrong-secret', {
          issuer: 'unn-pay',
          audience: 'unn-pay-student',
          expiresIn: '15m',
        });

      const response = await api()
        .get('/api/v1/fees')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(response.body.error.code).toBe('invalid_token');
    });

    it('rejects an expired access token', async () => {
      const expired = require('jsonwebtoken').sign(
        { sub: String(student.student_id), typ: 'student' },
        process.env.JWT_ACCESS_SECRET,
        { issuer: 'unn-pay', audience: 'unn-pay-student', expiresIn: '-1s' }
      );

      const response = await api()
        .get('/api/v1/fees')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);
      expect(response.body.error.code).toBe('token_expired');
    });

    it('refuses a student token on an admin endpoint, and the reverse', async () => {
      const admin = await createAdmin({ role: 'Super Admin' });
      const adminTokens = await loginAdmin(admin);

      await api().get('/api/v1/admin/transactions').set(auth(tokens)).expect(401);
      await api().get('/api/v1/fees').set(auth(adminTokens)).expect(401);
    });

    it('rotates the refresh token on every use', async () => {
      const first = await api()
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: tokens.refresh_token })
        .expect(200);

      expect(first.body.tokens.refresh_token).not.toBe(tokens.refresh_token);

      const second = await api()
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: first.body.tokens.refresh_token })
        .expect(200);

      expect(second.body.tokens.refresh_token).not.toBe(first.body.tokens.refresh_token);
    });

    it('detects reuse of a consumed refresh token and revokes the whole family', async () => {
      const rotated = await api()
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: tokens.refresh_token })
        .expect(200);

      // The original token is replayed — the signature of a stolen token.
      const replay = await api()
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: tokens.refresh_token })
        .expect(401);
      expect(replay.body.error.code).toBe('refresh_token_reused');

      // Both the thief and the legitimate holder are now logged out; there is
      // no way to tell which caller was which, so neither is trusted.
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: rotated.body.tokens.refresh_token })
        .expect(401);

      const family = await db.RefreshToken.findAll();
      expect(family.every((row) => row.revoked_at !== null)).toBe(true);
    });

    it('stores refresh tokens hashed, never in plaintext', async () => {
      const rows = await db.RefreshToken.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toHaveLength(64);
      expect(rows[0].token_hash).not.toBe(tokens.refresh_token);
    });

    it('ends every session when the password is reset', async () => {
      const { drainOutbox, email } = require('../helpers/api');

      await api()
        .post('/api/v1/auth/forgot-password')
        .send({ matric_number: student.matric_number })
        .expect(202);
      await drainOutbox();

      const message = email().lastOfKind('password_reset_otp', student.email);
      await api()
        .post('/api/v1/auth/reset-password')
        .send({
          matric_number: student.matric_number,
          code: message.payload.code,
          password: 'BrandNewPassword1',
        })
        .expect(200);

      await api()
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: tokens.refresh_token })
        .expect(401);
    });

    it('stops working the moment an account is suspended', async () => {
      await api().get('/api/v1/fees').set(auth(tokens)).expect(200);
      await student.update({ status: 'suspended' });

      const response = await api().get('/api/v1/fees').set(auth(tokens)).expect(403);
      expect(response.body.error.code).toBe('account_suspended');
    });
  });

  describe('receipt verification (§8)', () => {
    it('rejects a receipt whose stored signature no longer matches', async () => {
      const student = await createStudent({ status: 'active' });
      const feeItem = await createFeeItem({});
      const tokens = await loginStudent(student);

      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
      });
      await deliverWebhook(webhook);

      const receipt = await db.Receipt.findOne();

      // Verifies while genuine.
      const genuine = await api()
        .get(`/verify/${receipt.verification_code}`)
        .set('Accept', 'application/json')
        .expect(200);
      expect(genuine.body.valid).toBe(true);

      // Someone edits the amount directly in the database — the closest a
      // forger can get if they somehow reach it.
      await db.sequelize.query('UPDATE receipts SET amount = :amount WHERE receipt_id = :id', {
        replacements: { amount: '1.00', id: receipt.receipt_id },
      });

      const tampered = await api()
        .get(`/verify/${receipt.verification_code}`)
        .set('Accept', 'application/json')
        .expect(404);

      expect(tampered.body).toEqual({ valid: false, reason: 'signature_mismatch' });
    });

    it('reports an invented code as simply not existing', async () => {
      const response = await api()
        .get('/verify/UNN-ZZZZ-ZZZZ')
        .set('Accept', 'application/json')
        .expect(404);
      expect(response.body).toEqual({ valid: false, reason: 'not_found' });
    });

    it('reports a malformed code without touching the database', async () => {
      const response = await api()
        .get('/verify/nonsense')
        .set('Accept', 'application/json')
        .expect(404);
      expect(response.body.reason).toBe('malformed_code');
    });

    it('exposes nothing beyond the fields the specification permits', async () => {
      const student = await createStudent({ status: 'active' });
      const feeItem = await createFeeItem({});
      const tokens = await loginStudent(student);
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
      });
      await deliverWebhook(webhook);

      const receipt = await db.Receipt.findOne();
      const response = await api()
        .get(`/verify/${receipt.verification_code}`)
        .set('Accept', 'application/json')
        .expect(200);

      expect(Object.keys(response.body.receipt).sort()).toEqual([
        'amount',
        'amount_formatted',
        'fee_item',
        'issued_at',
        'matric_number',
        'paid_at',
        'receipt_number',
        'student_name',
        'unn_reference',
        'verification_code',
      ]);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(student.email);
      expect(serialised).not.toContain(student.phone);
      expect(serialised).not.toContain('signature');
    });

    it('serves a human readable page to a browser', async () => {
      const response = await api()
        .get('/verify/UNN-ZZZZ-ZZZZ')
        .set('Accept', 'text/html')
        .expect(404);

      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text).toContain('Not a valid receipt');
      expect(response.headers['cache-control']).toContain('no-store');
    });
  });

  describe('enumeration resistance', () => {
    it('gives the same answer whether or not a matric number exists', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });

      const known = await api()
        .post('/api/v1/auth/activate/request')
        .send({ matric_number: student.matric_number })
        .expect(202);

      const unknown = await api()
        .post('/api/v1/auth/activate/request')
        .send({ matric_number: '2099/999999' })
        .expect(202);

      expect(known.body.message).toBe(unknown.body.message);
    });

    it('does not distinguish a wrong password from a missing account', async () => {
      const student = await createStudent({ status: 'active' });

      const wrongPassword = await api()
        .post('/api/v1/auth/login')
        .send({ matric_number: student.matric_number, password: 'WrongPassword1' })
        .expect(401);

      const noSuchAccount = await api()
        .post('/api/v1/auth/login')
        .send({ matric_number: '2099/999999', password: 'WrongPassword1' })
        .expect(401);

      expect(wrongPassword.body.error).toMatchObject(
        expect.objectContaining({ code: 'invalid_credentials' })
      );
      expect(noSuchAccount.body.error.code).toBe('invalid_credentials');
      expect(wrongPassword.body.error.message).toBe(noSuchAccount.body.error.message);
    });
  });

  describe('secrets and headers', () => {
    it('never returns a password hash from any endpoint', async () => {
      const student = await createStudent({ status: 'active' });
      const tokens = await loginStudent(student);

      const response = await api().get('/api/v1/auth/me').set(auth(tokens)).expect(200);
      expect(JSON.stringify(response.body)).not.toContain('password');
      expect(response.body.student.password_hash).toBeUndefined();
    });

    it('stores OTPs hashed, never in plaintext', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await api()
        .post('/api/v1/auth/activate/request')
        .send({ matric_number: student.matric_number })
        .expect(202);

      const token = await db.AuthToken.findOne();
      expect(token.code_hash).toMatch(/^\$2[aby]\$12\$/);
      expect(token.code_hash).not.toMatch(/^\d{6}$/);
    });

    it('sets the security headers helmet is there for', async () => {
      const response = await api().get('/health').expect(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('returns a correlation id on every response', async () => {
      const response = await api().get('/health').expect(200);
      expect(response.headers['x-correlation-id']).toMatch(/[0-9a-f-]{36}/);
    });

    it('rejects an origin that is not on the allowlist', async () => {
      const response = await api()
        .get('/api/v1/fees')
        .set('Origin', 'https://not-unn.example.com');
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('SQL injection', () => {
    it('rejects an over long injection payload at validation, before any query', async () => {
      const admin = await createAdmin({ role: 'Super Admin' });
      const adminTokens = await loginAdmin(admin);

      const response = await api()
        .get('/api/v1/admin/transactions')
        .query({ matric_number: "2022/000001'; DROP TABLE transactions; --" })
        .set(auth(adminTokens))
        .expect(422);

      expect(response.body.error.code).toBe('validation_error');
      expect(await db.Transaction.count()).toBe(0);
    });

    it('treats a short injection attempt as literal search text', async () => {
      const admin = await createAdmin({ role: 'Super Admin' });
      const adminTokens = await loginAdmin(admin);
      const student = await createStudent({ status: 'active' });
      const feeItem = await createFeeItem({});
      await initiatePayment(await loginStudent(student), feeItem.fee_item_id).expect(201);

      // Short enough to pass validation, so it reaches the query layer — where
      // Sequelize binds it as a parameter rather than interpolating it.
      const response = await api()
        .get('/api/v1/admin/transactions')
        .query({ matric_number: "' OR 1=1 --" })
        .set(auth(adminTokens))
        .expect(200);

      // Matched literally against nothing, rather than returning every row.
      expect(response.body.items).toEqual([]);
      expect(await db.Transaction.count()).toBe(1);

      // And a genuine search still works, proving the filter is live.
      const real = await api()
        .get('/api/v1/admin/transactions')
        .query({ matric_number: student.matric_number })
        .set(auth(adminTokens))
        .expect(200);
      expect(real.body.items).toHaveLength(1);
    });

    it('rejects an injection attempt in a payment reference', async () => {
      const student = await createStudent({ status: 'active' });
      const tokens = await loginStudent(student);

      const response = await api()
        .get("/api/v1/payments/UNN' OR '1'='1")
        .set(auth(tokens));

      expect([400, 404]).toContain(response.status);
    });
  });
});
