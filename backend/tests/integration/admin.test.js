'use strict';

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
  drainOutbox,
  resetAdapters,
  email,
} = require('../helpers/api');
const { toKobo } = require('../../src/lib/money');

/**
 * Bursary administration (§11.6, §10).
 */

jest.setTimeout(60000);

const CSV_HEADER = 'matric_number,full_name,email,department,level,phone';

describe('Admin', () => {
  let admin;
  let adminTokens;

  beforeEach(async () => {
    await resetDatabase();
    resetAdapters();
    admin = await createAdmin({ role: 'Super Admin' });
    adminTokens = await loginAdmin(admin);
  });

  afterAll(closeDatabase);

  describe('student import (§11.6)', () => {
    const upload = (csv, session = '2025/2026') =>
      api()
        .post('/api/v1/admin/students/import')
        .set(auth(adminTokens))
        .field('session', session)
        .attach('file', Buffer.from(csv, 'utf8'), 'students.csv');

    it('previews without writing a single student row', async () => {
      const csv = [
        CSV_HEADER,
        '2022/248400,Chidera Okonkwo,chidera@example.unn.edu.ng,Computer Science,400,08030000001',
        '2022/248401,Amaka Nwosu,amaka@example.unn.edu.ng,Computer Science,400,08030000002',
      ].join('\n');

      const response = await upload(csv).expect(200);

      expect(response.body).toMatchObject({
        row_count: 2,
        will_create: 2,
        will_update: 0,
        failure_count: 0,
        committed: false,
        status: 'previewed',
      });

      // Nothing has been written. That is the entire point.
      expect(await db.Student.count()).toBe(0);
    });

    it('reports every invalid row with its row number', async () => {
      const csv = [
        CSV_HEADER,
        '2022/248400,Valid Student,valid@example.unn.edu.ng,Computer Science,400,',
        'BADMATRIC,Bad Matric,bad@example.unn.edu.ng,Computer Science,400,',
        '2022/248402,,noname@example.unn.edu.ng,Computer Science,400,',
        '2022/248403,No Email,not-an-email,Computer Science,400,',
        '2022/248404,No Department,nodept@example.unn.edu.ng,,400,',
        '2022/248400,Duplicate Matric,dup@example.unn.edu.ng,Computer Science,400,',
      ].join('\n');

      const response = await upload(csv).expect(200);

      expect(response.body.failure_count).toBe(5);
      expect(response.body.will_create).toBe(1);

      const rows = response.body.errors.map((e) => e.row);
      expect(rows).toEqual([3, 4, 5, 6, 7]);

      expect(response.body.errors[0].errors[0]).toMatch(/not in the format/);
      expect(response.body.errors[1].errors[0]).toMatch(/full_name is missing/);
      expect(response.body.errors[2].errors[0]).toMatch(/not a valid address/);
      expect(response.body.errors[3].errors[0]).toMatch(/department is missing/);
      expect(response.body.errors[4].errors[0]).toMatch(/also appears on row 2/);
    });

    it('refuses to commit a file with errors unless partial import is confirmed', async () => {
      const csv = [
        CSV_HEADER,
        '2022/248400,Valid Student,valid@example.unn.edu.ng,Computer Science,400,',
        'BADMATRIC,Bad Matric,bad@example.unn.edu.ng,Computer Science,400,',
      ].join('\n');

      const preview = await upload(csv).expect(200);

      const refused = await api()
        .post(`/api/v1/admin/students/imports/${preview.body.import_id}/commit`)
        .set(auth(adminTokens))
        .send({})
        .expect(400);

      expect(refused.body.error.code).toBe('import_has_errors');
      expect(await db.Student.count()).toBe(0);

      // With explicit confirmation, only the valid rows land.
      const committed = await api()
        .post(`/api/v1/admin/students/imports/${preview.body.import_id}/commit`)
        .set(auth(adminTokens))
        .send({ allow_partial: true })
        .expect(200);

      expect(committed.body).toMatchObject({ created: 1, updated: 0, committed: true });
      expect(await db.Student.count()).toBe(1);
    });

    it('commits every valid row in one transaction, all imported and unactivated', async () => {
      const csv = [
        CSV_HEADER,
        '2022/248400,Chidera Okonkwo,chidera@example.unn.edu.ng,Computer Science,400,08030000001',
        '2022/248401,Amaka Nwosu,amaka@example.unn.edu.ng,Computer Science,400,',
        '2021/554120,Ngozi Adeyemi,ngozi@example.unn.edu.ng,Mechanical Engineering,500,',
      ].join('\n');

      const preview = await upload(csv).expect(200);
      await api()
        .post(`/api/v1/admin/students/imports/${preview.body.import_id}/commit`)
        .set(auth(adminTokens))
        .send({})
        .expect(200);

      const students = await db.Student.findAll({ order: [['student_id', 'ASC']] });
      expect(students).toHaveLength(3);
      for (const student of students) {
        expect(student.status).toBe('imported');
      }
      // Password hashes are null until the student activates (§7.1).
      const withSecrets = await db.Student.scope('withSecrets').findAll();
      expect(withSecrets.every((s) => s.password_hash === null)).toBe(true);
    });

    it('refuses to commit the same import twice', async () => {
      const csv = [CSV_HEADER, '2022/248400,A B,ab@example.unn.edu.ng,CS,400,'].join('\n');
      const preview = await upload(csv).expect(200);

      await api()
        .post(`/api/v1/admin/students/imports/${preview.body.import_id}/commit`)
        .set(auth(adminTokens))
        .send({})
        .expect(200);

      const second = await api()
        .post(`/api/v1/admin/students/imports/${preview.body.import_id}/commit`)
        .set(auth(adminTokens))
        .send({})
        .expect(409);

      expect(second.body.error.code).toBe('import_already_committed');
      expect(await db.Student.count()).toBe(1);
    });

    it('updates an existing student without touching their credentials or status', async () => {
      const existing = await createStudent({
        matric_number: '2022/248400',
        status: 'active',
        department: 'Old Department',
      });
      const originalHash = (
        await db.Student.scope('withSecrets').findByPk(existing.student_id)
      ).password_hash;

      const csv = [
        CSV_HEADER,
        `2022/248400,Updated Name,${existing.email},New Department,500,08099999999`,
      ].join('\n');

      const preview = await upload(csv).expect(200);
      expect(preview.body.will_update).toBe(1);
      expect(preview.body.will_create).toBe(0);

      await api()
        .post(`/api/v1/admin/students/imports/${preview.body.import_id}/commit`)
        .set(auth(adminTokens))
        .send({})
        .expect(200);

      const after = await db.Student.scope('withSecrets').findByPk(existing.student_id);
      expect(after.full_name).toBe('Updated Name');
      expect(after.department).toBe('New Department');
      // An active student stays active, and keeps their password.
      expect(after.status).toBe('active');
      expect(after.password_hash).toBe(originalHash);
    });

    it('flags an email already belonging to a different matric number', async () => {
      await createStudent({ matric_number: '2022/111111', email: 'taken@example.unn.edu.ng' });

      const csv = [
        CSV_HEADER,
        '2022/222222,Someone Else,taken@example.unn.edu.ng,Computer Science,400,',
      ].join('\n');

      const preview = await upload(csv).expect(200);
      expect(preview.body.failure_count).toBe(1);
      expect(preview.body.errors[0].errors[0]).toMatch(/already used by matric number 2022\/111111/);
    });

    it('accepts the header spellings a spreadsheet actually produces', async () => {
      const csv = [
        'Matric Number,Full Name,Email Address,Department,Level',
        '2022/248400,Chidera Okonkwo,chidera@example.unn.edu.ng,Computer Science,400',
      ].join('\n');

      const response = await upload(csv).expect(200);
      expect(response.body.will_create).toBe(1);
      expect(response.body.failure_count).toBe(0);
    });

    it('rejects a file missing a required column, naming what is missing', async () => {
      const csv = ['matric_number,full_name', '2022/248400,Chidera Okonkwo'].join('\n');

      const response = await upload(csv).expect(400);
      expect(response.body.error.code).toBe('csv_missing_columns');
      expect(response.body.error.message).toMatch(/email/);
    });

    it('rejects a file that is not a CSV', async () => {
      await api()
        .post('/api/v1/admin/students/import')
        .set(auth(adminTokens))
        .field('session', '2025/2026')
        .attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' })
        .expect(400);
    });
  });

  describe('unapplied payment resolution (§10)', () => {
    let student;
    let feeItem;
    let unapplied;
    let transaction;

    beforeEach(async () => {
      student = await createStudent({ status: 'active' });
      feeItem = await createFeeItem({ amount: '68500.00' });
      const tokens = await loginStudent(student);

      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
        amountKobo: toKobo('60000.00'), // an underpayment
      });
      await deliverWebhook(webhook);

      unapplied = await db.UnappliedPayment.findOne();
      transaction = await db.Transaction.findOne();
    });

    it('lists the open queue with the figures Bursary needs', async () => {
      const response = await api()
        .get('/api/v1/admin/unapplied')
        .set(auth(adminTokens))
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        reason: 'underpayment',
        status: 'open',
        amount_received: '60000.00',
        amount_expected: '68500.00',
        variance: '-8500.00',
      });
      expect(response.body.items[0].student.matric_number).toBe(student.matric_number);
      expect(response.body.items[0].days_remaining).toBeGreaterThan(88);
    });

    it('requires a note on every resolution', async () => {
      const response = await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send({ resolution: 'dismissed' })
        .expect(422);

      expect(response.body.error.code).toBe('validation_error');
    });

    it('applies to the intended fee, settling it and issuing the withheld receipt', async () => {
      const response = await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send({
          resolution: 'applied_to_intended_fee',
          note: 'Student paid the balance in cash at the Bursary counter, receipt 4471.',
        })
        .expect(200);

      expect(response.body.receipt_number).toBeTruthy();

      const settled = await transaction.reload();
      expect(settled.status).toBe('Successful');
      expect(settled.amount_paid).toBe('60000.00');

      const receipt = await db.Receipt.findOne();
      expect(receipt.transaction_id).toBe(transaction.transaction_id);

      const resolved = await unapplied.reload();
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolved_by_admin_id).toBe(admin.admin_id);
      expect(resolved.resolution_note).toMatch(/receipt 4471/);
      expect(resolved.resolved_at).toBeTruthy();
    });

    it('applies to a different fee item, creating its own transaction and receipt', async () => {
      const otherFee = await createFeeItem({ name: 'Hostel', amount: '18000.00' });

      await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send({
          resolution: 'applied_to_other_fee',
          note: 'Student intended to pay hostel accommodation, not school fees.',
          target_fee_item_id: otherFee.fee_item_id,
        })
        .expect(200);

      const applied = await db.Transaction.findOne({
        where: { fee_item_id: otherFee.fee_item_id, status: 'Successful' },
      });
      expect(applied).toBeTruthy();
      expect(applied.adapter).toBe('manual');
      expect(applied.amount_paid).toBe('60000.00');

      // The original attempt is left as it was, for the audit trail.
      const original = await transaction.reload();
      expect(original.status).toBe('UnderReview');
    });

    it('records a refund without settling anything', async () => {
      await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send({ resolution: 'marked_for_refund', note: 'Student withdrew; refund approved.' })
        .expect(200);

      expect(await db.Receipt.count()).toBe(0);
      const settled = await transaction.reload();
      expect(settled.status).toBe('UnderReview');

      const resolved = await unapplied.reload();
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolution).toBe('marked_for_refund');
    });

    it('refuses to resolve the same item twice', async () => {
      const payload = { resolution: 'dismissed', note: 'Duplicate of an earlier entry.' };

      await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send(payload)
        .expect(200);

      const second = await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send(payload)
        .expect(409);

      expect(second.body.error.code).toBe('already_resolved');
    });

    it('writes every resolution to the audit log with the acting admin', async () => {
      await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send({ resolution: 'dismissed', note: 'Resolved at the counter in person.' })
        .expect(200);

      const entry = await db.AuditLog.findOne({
        where: { action: 'unapplied.resolved' },
      });
      expect(entry).toMatchObject({
        actor_type: 'admin',
        actor_id: admin.admin_id,
        entity_type: 'unapplied_payment',
      });
      expect(entry.before_state.status).toBe('open');
      expect(entry.after_state.status).toBe('resolved');
    });

    it('expires an item past its deadline but keeps it permanently and resolvable', async () => {
      await unapplied.update({ deadline_at: new Date(Date.now() - 1000) });

      const { expireUnappliedPayments } = require('../../src/worker/jobs/dailyMaintenance');
      const result = await expireUnappliedPayments();
      expect(result.expired).toBe(1);

      const expired = await unapplied.reload();
      expect(expired.status).toBe('expired');

      // Never deleted, and still visible to Bursary.
      const listed = await api()
        .get('/api/v1/admin/unapplied?status=expired')
        .set(auth(adminTokens))
        .expect(200);
      expect(listed.body.items).toHaveLength(1);

      // And Bursary can still resolve it at any later date.
      await api()
        .post(`/api/v1/admin/unapplied/${unapplied.unapplied_id}/resolve`)
        .set(auth(adminTokens))
        .send({
          resolution: 'applied_to_intended_fee',
          note: 'Student came in a year later with the bank slip; applied.',
        })
        .expect(200);

      expect(await db.Receipt.count()).toBe(1);
    });
  });

  describe('fee items (§11.6)', () => {
    it('creates, updates and soft deletes, never hard deleting', async () => {
      const created = await api()
        .post('/api/v1/admin/fee-items')
        .set(auth(adminTokens))
        .send({
          name: 'Departmental Dues',
          category: 'Departmental',
          amount: '5000.00',
          department: 'Computer Science',
          session: '2025/2026',
        })
        .expect(201);

      const id = created.body.fee_item.fee_item_id;
      expect(created.body.fee_item.amount).toBe('5000.00');

      await api()
        .put(`/api/v1/admin/fee-items/${id}`)
        .set(auth(adminTokens))
        .send({ amount: '5500.00' })
        .expect(200);

      await api().delete(`/api/v1/admin/fee-items/${id}`).set(auth(adminTokens)).expect(200);

      // Still present, just inactive.
      const row = await db.FeeItem.findByPk(id);
      expect(row).not.toBeNull();
      expect(row.is_active).toBe(false);
      expect(row.amount).toBe('5500.00');
    });

    it('rejects an amount with sub kobo precision', async () => {
      await api()
        .post('/api/v1/admin/fee-items')
        .set(auth(adminTokens))
        .send({
          name: 'Bad Amount',
          category: 'Other',
          amount: '100.005',
          session: '2025/2026',
        })
        .expect(422);
    });

    it('audits every change', async () => {
      const created = await api()
        .post('/api/v1/admin/fee-items')
        .set(auth(adminTokens))
        .send({ name: 'Sports Levy', category: 'Other', amount: '2000.00', session: '2025/2026' })
        .expect(201);

      await api()
        .put(`/api/v1/admin/fee-items/${created.body.fee_item.fee_item_id}`)
        .set(auth(adminTokens))
        .send({ amount: '2500.00' })
        .expect(200);

      const entries = await db.AuditLog.findAll({
        where: { entity_type: 'fee_item' },
        order: [['audit_id', 'ASC']],
      });
      expect(entries.map((e) => e.action)).toEqual(['fee_item.created', 'fee_item.updated']);
      expect(entries[1].before_state.amount).toBe('2000.00');
      expect(entries[1].after_state.amount).toBe('2500.00');
    });
  });

  describe('transactions and export (§11.6)', () => {
    beforeEach(async () => {
      const student = await createStudent({ status: 'active', department: 'Computer Science' });
      const feeItem = await createFeeItem({ amount: '68500.00' });
      const tokens = await loginStudent(student);
      const initiated = await initiatePayment(tokens, feeItem.fee_item_id).expect(201);
      const { webhook } = await sandbox().simulatePayment({
        unnReference: initiated.body.payment.unn_reference,
      });
      await deliverWebhook(webhook);
    });

    it('filters by status and department', async () => {
      const successful = await api()
        .get('/api/v1/admin/transactions?status=Successful')
        .set(auth(adminTokens))
        .expect(200);
      expect(successful.body.items).toHaveLength(1);

      const wrongDepartment = await api()
        .get('/api/v1/admin/transactions?department=Law')
        .set(auth(adminTokens))
        .expect(200);
      expect(wrongDepartment.body.items).toHaveLength(0);
    });

    it('exports CSV with a header row and the receipt number', async () => {
      const response = await api()
        .get('/api/v1/admin/transactions/export?format=csv')
        .set(auth(adminTokens))
        .expect(200);

      expect(response.headers['content-type']).toMatch(/text\/csv/);
      expect(response.headers['content-disposition']).toMatch(/attachment; filename=/);

      const [header, firstRow] = response.text.trim().split('\n');
      expect(header).toContain('UNN Reference');
      expect(header).toContain('Paid At (WAT)');
      expect(firstRow).toContain('UNN/2025-2026/000001');
      expect(firstRow).toContain('68500.00');
    });

    it('exports a PDF report', async () => {
      const response = await api()
        .get('/api/v1/admin/transactions/export?format=pdf')
        .set(auth(adminTokens))
        .expect(200);

      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.body.slice(0, 5).toString()).toBe('%PDF-');
      expect(response.body.length).toBeGreaterThan(1000);
    });
  });

  describe('operational health panel (§9.6)', () => {
    it('reports stuck payments, unapplied items, dead outbox entries and breaker state', async () => {
      const response = await api()
        .get('/api/v1/admin/dashboard/health')
        .set(auth(adminTokens))
        .expect(200);

      expect(response.body).toMatchObject({
        pending_older_than_30_minutes: expect.any(Number),
        open_unapplied_payments: expect.any(Number),
        outbox: expect.objectContaining({ pending: expect.any(Number), dead: expect.any(Number) }),
        dead_outbox_entries: expect.any(Array),
        bank_adapter: { name: 'sandbox' },
      });
      expect(response.body.circuit_breaker.state).toBe('closed');
    });
  });

  describe('access control (§11.6)', () => {
    it('requires authentication for every admin route', async () => {
      await api().get('/api/v1/admin/transactions').expect(401);
      await api().get('/api/v1/admin/unapplied').expect(401);
      await api().get('/api/v1/admin/dashboard/health').expect(401);
    });

    it('restricts staff creation to a Super Admin', async () => {
      const staff = await createAdmin({ role: 'Bursary Staff' });
      const staffTokens = await loginAdmin(staff);

      const forbidden = await api()
        .post('/api/v1/admin/staff')
        .set(auth(staffTokens))
        .send({
          staff_id: 'BUR999',
          full_name: 'New Person',
          email: 'new@unn.edu.ng',
          password: 'AVeryStrongPassword1',
          role: 'Bursary Staff',
        })
        .expect(403);

      expect(forbidden.body.error.code).toBe('super_admin_required');

      await api()
        .post('/api/v1/admin/staff')
        .set(auth(adminTokens))
        .send({
          staff_id: 'BUR999',
          full_name: 'New Person',
          email: 'new@unn.edu.ng',
          password: 'AVeryStrongPassword1',
          role: 'Bursary Staff',
        })
        .expect(201);
    });

    it('has no public admin registration endpoint at all', async () => {
      const before = await db.AdminUser.count();

      const attempts = await Promise.all(
        [
          '/api/v1/admin/register',
          '/api/v1/admin/signup',
          '/api/v1/auth/admin/register',
          '/api/v1/admin/staff',
        ].map((path) =>
          api().post(path).send({
            staff_id: 'HACK001',
            full_name: 'Uninvited',
            email: 'uninvited@example.com',
            password: 'AVeryStrongPassword1',
            role: 'Super Admin',
          })
        )
      );

      // 401 (the admin gate answers first) or 404 (no such route) — never a
      // success. The property that matters is that no account can be created.
      for (const response of attempts) {
        expect([401, 404]).toContain(response.status);
      }
      expect(await db.AdminUser.count()).toBe(before);
    });

    it('records admin logins, successful and failed', async () => {
      await api()
        .post('/api/v1/admin/login')
        .send({ email: admin.email, password: 'TheWrongPassword' })
        .expect(401);

      const actions = (
        await db.AuditLog.findAll({ where: { entity_type: 'admin_user' } })
      ).map((e) => e.action);

      expect(actions).toContain('admin.login');
      expect(actions).toContain('admin.login_failed');
    });

    it('refuses a disabled admin account', async () => {
      const disabled = await createAdmin({ is_active: false });
      await api()
        .post('/api/v1/admin/login')
        .send({ email: disabled.email, password: 'AdminPassword123' })
        .expect(401);
    });
  });
});
