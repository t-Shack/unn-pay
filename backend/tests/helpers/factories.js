'use strict';

const { db } = require('./setup');
const { hashSecret } = require('../../src/lib/hash');

/**
 * Test fixtures. Deliberately explicit rather than clever: a test that fails
 * should point at the behaviour, not at a factory.
 */

let counter = 0;
const next = () => (counter += 1);

async function createStudent(overrides = {}) {
  const n = next();
  const serial = String(400000 + n).padStart(6, '0');
  const password = overrides.password || 'Password123';

  return db.Student.create({
    matric_number: overrides.matric_number || `2022/${serial}`,
    full_name: overrides.full_name || `Test Student ${n}`,
    email: overrides.email || `student${n}@example.unn.edu.ng`,
    phone: overrides.phone || '08030000000',
    department: overrides.department || 'Computer Science',
    level: overrides.level || '400',
    status: overrides.status || 'active',
    password_hash:
      overrides.password_hash !== undefined
        ? overrides.password_hash
        : overrides.status === 'imported'
          ? null
          : await hashSecret(password),
  });
}

async function createAdmin(overrides = {}) {
  const n = next();
  return db.AdminUser.create({
    staff_id: overrides.staff_id || `BUR${String(n).padStart(3, '0')}`,
    full_name: overrides.full_name || `Test Admin ${n}`,
    email: overrides.email || `admin${n}@unn.edu.ng`,
    password_hash: await hashSecret(overrides.password || 'AdminPassword123'),
    role: overrides.role || 'Bursary Staff',
    is_active: overrides.is_active !== undefined ? overrides.is_active : true,
  });
}

async function createFeeItem(overrides = {}) {
  const n = next();
  return db.FeeItem.create({
    name: overrides.name || `Test Fee ${n}`,
    category: overrides.category || 'Tuition',
    amount: overrides.amount || '68500.00',
    department: overrides.department !== undefined ? overrides.department : null,
    level: overrides.level !== undefined ? overrides.level : null,
    session: overrides.session || '2025/2026',
    is_active: overrides.is_active !== undefined ? overrides.is_active : true,
  });
}

module.exports = { createStudent, createAdmin, createFeeItem };
