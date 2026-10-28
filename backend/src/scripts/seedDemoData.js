'use strict';

/**
 * Seed a demonstration data set: one Super Admin, a handful of students across
 * two departments, and the fee items for the 2025/2026 session.
 *
 * Development and demonstration only. It refuses to run against NODE_ENV
 * production, because inventing students and fees in a live system would be
 * indistinguishable from an attack.
 *
 *   npm run seed:demo
 */

const { Student, FeeItem, AdminUser, sequelize } = require('../models');
const { hashSecret } = require('../lib/hash');
const config = require('../config');

const SESSION = '2025/2026';

const STUDENTS = [
  ['2022/248400', 'Chidera Okonkwo', 'chidera.okonkwo@example.unn.edu.ng', 'Computer Science', '400'],
  ['2022/248401', 'Amaka Nwosu', 'amaka.nwosu@example.unn.edu.ng', 'Computer Science', '400'],
  ['2023/119872', 'Emeka Eze', 'emeka.eze@example.unn.edu.ng', 'Computer Science', '300'],
  ['2021/554120', 'Ngozi Adeyemi', 'ngozi.adeyemi@example.unn.edu.ng', 'Mechanical Engineering', '500'],
  ['2024/770031', 'Tunde Balogun', 'tunde.balogun@example.unn.edu.ng', 'Mechanical Engineering', '100'],
];

const FEE_ITEMS = [
  ['School Fees (Undergraduate)', 'Tuition', '68500.00', null, null],
  ['Acceptance Fee', 'Acceptance', '25000.00', null, '100'],
  ['Departmental Dues — Computer Science', 'Departmental', '5000.00', 'Computer Science', null],
  ['Departmental Dues — Mechanical Engineering', 'Departmental', '5500.00', 'Mechanical Engineering', null],
  ['Hostel Accommodation', 'Hostel', '18000.00', null, null],
  ['Sports and Games Levy', 'Other', '2000.00', null, null],
];

async function main() {
  if (config.isProduction) {
    console.error('Refusing to seed demonstration data in production.');
    process.exit(1);
  }

  await sequelize.transaction(async (t) => {
    const [admin, adminCreated] = await AdminUser.findOrCreate({
      where: { email: 'bursar@unn.edu.ng' },
      defaults: {
        staff_id: 'BUR001',
        full_name: 'Demo Bursar',
        email: 'bursar@unn.edu.ng',
        password_hash: await hashSecret('DemoBursary2026!'),
        role: AdminUser.ROLES.SUPER_ADMIN,
        is_active: true,
      },
      transaction: t,
    });

    let studentsCreated = 0;
    for (const [matric, name, email, department, level] of STUDENTS) {
      const [, created] = await Student.findOrCreate({
        where: { matric_number: matric },
        defaults: {
          matric_number: matric,
          full_name: name,
          email,
          department,
          level,
          // Imported, not active: activation is the student's own step, and that
          // is exactly what makes matric verification real.
          status: 'imported',
        },
        transaction: t,
      });
      if (created) studentsCreated += 1;
    }

    let feesCreated = 0;
    for (const [name, category, amount, department, level] of FEE_ITEMS) {
      const [, created] = await FeeItem.findOrCreate({
        where: { name, session: SESSION },
        defaults: { name, category, amount, department, level, session: SESSION, is_active: true },
        transaction: t,
      });
      if (created) feesCreated += 1;
    }

    console.log('Demo data seeded:');
    console.log(`  admin     ${adminCreated ? 'created' : 'already present'}  bursar@unn.edu.ng / DemoBursary2026!`);
    console.log(`  students  ${studentsCreated} created (${STUDENTS.length} total), all status "imported"`);
    console.log(`  fee items ${feesCreated} created (${FEE_ITEMS.length} total) for ${SESSION}`);
    console.log('');
    console.log('Next: activate a student.');
    console.log('  1. POST /api/v1/auth/activate/request  { "matric_number": "2022/248400" }');
    console.log('  2. Read the OTP from the API log (the console email provider prints it)');
    console.log('  3. POST /api/v1/auth/activate/confirm  { matric_number, code, password }');
  });

  await sequelize.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Seeding failed:', error.message);
    process.exit(1);
  });
}

module.exports = { STUDENTS, FEE_ITEMS, SESSION };
