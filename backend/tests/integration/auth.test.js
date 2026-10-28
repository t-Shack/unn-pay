'use strict';

const { resetDatabase, closeDatabase, db } = require('../helpers/setup');
const { createStudent, createFeeItem } = require('../helpers/factories');
const { api, drainOutbox, email, resetAdapters, auth, loginStudent } = require('../helpers/api');

/**
 * Student authentication (§11.1).
 *
 * Registration is not open: activation is only possible for a matric number the
 * Bursary has already imported. That is what makes matric verification real
 * rather than decorative, so most of what is tested here is what the API
 * refuses to do.
 */

jest.setTimeout(60000);

const requestActivation = (matricNumber) =>
  api().post('/api/v1/auth/activate/request').send({ matric_number: matricNumber });

const confirmActivation = (matricNumber, code, password) =>
  api()
    .post('/api/v1/auth/activate/confirm')
    .send({ matric_number: matricNumber, code, password });

async function otpFor(student, kind = 'activation_otp') {
  await drainOutbox();
  const message = email().lastOfKind(kind, student.email);
  if (!message) throw new Error(`no ${kind} queued for ${student.email}`);
  return message.payload.code;
}

describe('Student authentication', () => {
  beforeEach(async () => {
    await resetDatabase();
    resetAdapters();
  });

  afterAll(closeDatabase);

  describe('activation', () => {
    it('activates an imported student and signs them straight in', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });

      await requestActivation(student.matric_number).expect(202);
      const code = await otpFor(student);
      expect(code).toMatch(/^\d{6}$/);

      const response = await confirmActivation(student.matric_number, code, 'Password123').expect(200);

      expect(response.body.student.status).toBe('active');
      expect(response.body.tokens.access_token).toBeTruthy();
      expect(response.body.tokens.refresh_token).toBeTruthy();
      expect(response.body.tokens.expires_in).toBe(900);

      const updated = await db.Student.scope('withSecrets').findByPk(student.student_id);
      expect(updated.status).toBe('active');
      expect(updated.password_hash).toMatch(/^\$2[aby]\$12\$/);
    });

    it('will not activate a matric number the Bursary never imported', async () => {
      await requestActivation('2099/999999').expect(202);
      await drainOutbox();

      // No email is queued at all, and no token exists.
      expect(email().sent).toHaveLength(0);
      expect(await db.AuthToken.count()).toBe(0);
    });

    it('sends the code as selectable text and states its expiry (§3.2)', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await requestActivation(student.matric_number).expect(202);
      await drainOutbox();

      const message = email().lastOfKind('activation_otp', student.email);
      expect(message.text).toMatch(/is: \d{6}/);
      expect(message.text).toMatch(/expires in 15 minutes/);
      expect(message.text).toMatch(/at \d+ \w+ \d{4} at \d{2}:\d{2} WAT/);
    });

    it('rejects a wrong code and counts the attempt', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await requestActivation(student.matric_number).expect(202);
      await otpFor(student);

      const response = await confirmActivation(student.matric_number, '000000', 'Password123').expect(400);
      expect(response.body.error.message).toMatch(/4 attempts remaining/);

      const token = await db.AuthToken.findOne();
      expect(token.attempt_count).toBe(1);
      expect(token.consumed_at).toBeNull();
    });

    it('invalidates the code after five wrong attempts (§11.1)', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await requestActivation(student.matric_number).expect(202);
      const code = await otpFor(student);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await confirmActivation(student.matric_number, '000000', 'Password123').expect(400);
      }

      // Even the correct code no longer works.
      const response = await confirmActivation(student.matric_number, code, 'Password123');
      expect([400, 429]).toContain(response.status);

      const after = await db.Student.findByPk(student.student_id);
      expect(after.status).toBe('imported');
    });

    it('rejects an expired code', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await requestActivation(student.matric_number).expect(202);
      const code = await otpFor(student);

      await db.AuthToken.update(
        { expires_at: new Date(Date.now() - 1000) },
        { where: { student_id: student.student_id } }
      );

      const response = await confirmActivation(student.matric_number, code, 'Password123').expect(400);
      expect(response.body.error.code).toBe('invalid_or_expired_code');
    });

    it('is single use: the same code cannot activate twice', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await requestActivation(student.matric_number).expect(202);
      const code = await otpFor(student);

      await confirmActivation(student.matric_number, code, 'Password123').expect(200);
      const second = await confirmActivation(student.matric_number, code, 'Different123').expect(409);
      expect(second.body.error.code).toBe('already_active');
    });

    it('invalidates an earlier code when a new one is requested', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });

      await requestActivation(student.matric_number).expect(202);
      const first = await otpFor(student);

      await requestActivation(student.matric_number).expect(202);
      const second = await otpFor(student);
      expect(second).not.toBe(first);

      await confirmActivation(student.matric_number, first, 'Password123').expect(400);
      await confirmActivation(student.matric_number, second, 'Password123').expect(200);
    });

    it.each([
      ['too short', 'Pass1'],
      ['no digits', 'PasswordOnly'],
      ['no letters', '12345678'],
    ])('rejects a weak password (%s)', async (_label, password) => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await requestActivation(student.matric_number).expect(202);
      const code = await otpFor(student);

      const response = await confirmActivation(student.matric_number, code, password);
      expect([400, 422]).toContain(response.status);

      const after = await db.Student.findByPk(student.student_id);
      expect(after.status).toBe('imported');
    });

    it.each([
      ['2022-248400', 'wrong separator'],
      ['22/248400', 'short year'],
      ['2022/24840', 'short serial'],
      ['abcd/efghij', 'not numeric'],
    ])('rejects a malformed matric number %p (%s)', async (matricNumber) => {
      const response = await requestActivation(matricNumber).expect(422);
      expect(response.body.error.code).toBe('validation_error');
    });

    it('refuses to activate a suspended account', async () => {
      const student = await createStudent({ status: 'suspended', password_hash: null });
      await requestActivation(student.matric_number).expect(202);
      await drainOutbox();
      expect(email().sent).toHaveLength(0);
    });
  });

  describe('login', () => {
    it('signs in an active student', async () => {
      const student = await createStudent({ status: 'active' });
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ matric_number: student.matric_number, password: 'Password123' })
        .expect(200);

      expect(response.body.student.matric_number).toBe(student.matric_number);
      expect(response.body.tokens.token_type).toBe('Bearer');
    });

    it('refuses a student who has not activated yet', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ matric_number: student.matric_number, password: 'Password123' })
        .expect(401);

      expect(response.body.error.code).toBe('invalid_credentials');
    });

    it('refuses a suspended student with a clear reason', async () => {
      const student = await createStudent({ status: 'suspended' });
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ matric_number: student.matric_number, password: 'Password123' })
        .expect(401);

      expect(response.body.error.code).toBe('account_suspended');
    });
  });

  describe('password reset', () => {
    it('resets the password and lets the student sign in with the new one', async () => {
      const student = await createStudent({ status: 'active' });

      await api()
        .post('/api/v1/auth/forgot-password')
        .send({ matric_number: student.matric_number })
        .expect(202);

      const code = await otpFor(student, 'password_reset_otp');

      await api()
        .post('/api/v1/auth/reset-password')
        .send({ matric_number: student.matric_number, code, password: 'BrandNewPass1' })
        .expect(200);

      await api()
        .post('/api/v1/auth/login')
        .send({ matric_number: student.matric_number, password: 'BrandNewPass1' })
        .expect(200);

      await api()
        .post('/api/v1/auth/login')
        .send({ matric_number: student.matric_number, password: 'Password123' })
        .expect(401);
    });

    it('says nothing about whether the account exists', async () => {
      const student = await createStudent({ status: 'active' });

      const known = await api()
        .post('/api/v1/auth/forgot-password')
        .send({ matric_number: student.matric_number })
        .expect(202);

      const unknown = await api()
        .post('/api/v1/auth/forgot-password')
        .send({ matric_number: '2099/999999' })
        .expect(202);

      expect(known.body).toEqual(unknown.body);
    });

    it('does not send a reset code to an unactivated account', async () => {
      const student = await createStudent({ status: 'imported', password_hash: null });
      await api()
        .post('/api/v1/auth/forgot-password')
        .send({ matric_number: student.matric_number })
        .expect(202);

      await drainOutbox();
      expect(email().sent).toHaveLength(0);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token so it cannot be used again', async () => {
      const student = await createStudent({ status: 'active' });
      const tokens = await loginStudent(student);

      await api()
        .post('/api/v1/auth/logout')
        .send({ refresh_token: tokens.refresh_token })
        .expect(200);

      await api()
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: tokens.refresh_token })
        .expect(401);
    });
  });

  describe('device registration (§11.5)', () => {
    it('registers a device and moves the token if the device changes hands', async () => {
      const alice = await createStudent({ status: 'active' });
      const bob = await createStudent({ status: 'active' });
      const token = 'fcm-token-'.padEnd(40, 'a');

      await api()
        .post('/api/v1/notifications/register-device')
        .set(auth(await loginStudent(alice)))
        .send({ fcm_token: token, platform: 'android' })
        .expect(200);

      await api()
        .post('/api/v1/notifications/register-device')
        .set(auth(await loginStudent(bob)))
        .send({ fcm_token: token, platform: 'android' })
        .expect(200);

      const rows = await db.DeviceToken.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].student_id).toBe(bob.student_id);
    });

    it('removes the token on logout', async () => {
      const student = await createStudent({ status: 'active' });
      const tokens = await loginStudent(student);
      const token = 'fcm-token-'.padEnd(40, 'b');

      await api()
        .post('/api/v1/notifications/register-device')
        .set(auth(tokens))
        .send({ fcm_token: token, platform: 'ios' })
        .expect(200);

      await api()
        .delete('/api/v1/notifications/register-device')
        .set(auth(tokens))
        .send({ fcm_token: token })
        .expect(200);

      expect(await db.DeviceToken.count()).toBe(0);
    });
  });

  describe('fee applicability (§11.2)', () => {
    it('shows only the fees that apply to this student', async () => {
      const student = await createStudent({
        status: 'active',
        department: 'Computer Science',
        level: '400',
      });

      const universal = await createFeeItem({ name: 'School Fees', department: null, level: null });
      const myDepartment = await createFeeItem({
        name: 'CS Dues',
        department: 'Computer Science',
        level: null,
        amount: '5000.00',
      });
      await createFeeItem({ name: 'Law Dues', department: 'Law', level: null });
      await createFeeItem({ name: 'Fresher Fee', department: null, level: '100' });
      await createFeeItem({ name: 'Retired Fee', is_active: false });

      const response = await api()
        .get('/api/v1/fees')
        .set(auth(await loginStudent(student)))
        .expect(200);

      const names = response.body.items.map((item) => item.name).sort();
      expect(names).toEqual(['CS Dues', 'School Fees']);

      // Total outstanding is the sum of what applies.
      expect(response.body.total_outstanding).toBe('73500.00');
      expect(response.body.total_outstanding_formatted).toBe('₦73,500.00');

      expect(universal.fee_item_id).toBeTruthy();
      expect(myDepartment.fee_item_id).toBeTruthy();
    });

    it('refuses to start a payment for a fee that does not apply', async () => {
      const student = await createStudent({ status: 'active', department: 'Computer Science' });
      const otherDepartment = await createFeeItem({ department: 'Law' });

      const response = await api()
        .post('/api/v1/payments/initiate')
        .set(auth(await loginStudent(student)))
        .send({ fee_item_id: otherDepartment.fee_item_id })
        .expect(400);

      expect(response.body.error.code).toBe('fee_item_not_applicable');
    });
  });
});
