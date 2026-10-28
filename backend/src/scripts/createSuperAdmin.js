'use strict';

/**
 * Seed the first Super Admin (§7.7).
 *
 * There is no public admin registration endpoint, ever. The first account is
 * created here, by someone with shell access to the deployment, and every
 * subsequent account is created by that Super Admin through the dashboard.
 *
 * Usage:
 *   npm run seed:superadmin -- --staff-id=BUR001 --name="Ada Obi" --email=ada@unn.edu.ng
 *
 * The password is read from the ADMIN_PASSWORD environment variable, or prompted
 * for interactively. It is never passed as an argument, because arguments end up
 * in shell history and in the process list.
 */

const readline = require('readline');
const { AdminUser, sequelize } = require('../models');
const { hashSecret } = require('../lib/hash');
const audit = require('../services/auditService');

function parseArgs(argv) {
  const args = {};
  for (const token of argv.slice(2)) {
    const match = /^--([^=]+)=?(.*)$/.exec(token);
    if (match) args[match[1]] = match[2] === '' ? true : match[2];
  }
  return args;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      const text = String(char);
      if (['\n', '\r', ''].includes(text)) {
        process.stdin.removeListener('data', onData);
      } else {
        // Redraw the prompt without echoing what was typed.
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function validatePassword(password) {
  const problems = [];
  if (!password || password.length < 12) problems.push('at least 12 characters');
  if (!/[a-z]/.test(password || '')) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password || '')) problems.push('an uppercase letter');
  if (!/\d/.test(password || '')) problems.push('a number');
  return problems;
}

async function main() {
  const args = parseArgs(process.argv);

  const staffId = args['staff-id'];
  const fullName = args.name;
  const email = args.email && String(args.email).toLowerCase();

  if (!staffId || !fullName || !email) {
    console.error(
      'Usage: npm run seed:superadmin -- --staff-id=BUR001 --name="Ada Obi" --email=ada@unn.edu.ng\n' +
        '  The password is read from ADMIN_PASSWORD, or prompted for.'
    );
    process.exit(1);
  }

  const password = process.env.ADMIN_PASSWORD || (await promptHidden('Password: '));
  const problems = validatePassword(password);
  if (problems.length > 0) {
    console.error(`Password is too weak. It needs ${problems.join(', ')}.`);
    process.exit(1);
  }

  const existing = await AdminUser.findOne({ where: { email } });
  if (existing) {
    console.error(`An admin with email ${email} already exists (id ${existing.admin_id}).`);
    process.exit(1);
  }

  const admin = await sequelize.transaction(async (t) => {
    const created = await AdminUser.create(
      {
        staff_id: staffId,
        full_name: fullName,
        email,
        password_hash: await hashSecret(password),
        role: AdminUser.ROLES.SUPER_ADMIN,
        is_active: true,
      },
      { transaction: t }
    );

    await audit.recordSystem({
      action: audit.ACTION.ADMIN_CREATED,
      entityType: 'admin_user',
      entityId: created.admin_id,
      after: { ...created.toPublicJSON(), created_by: 'cli' },
      transaction: t,
    });

    return created;
  });

  console.log(`Created Super Admin #${admin.admin_id}: ${admin.full_name} <${admin.email}>`);
  await sequelize.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
  });
}

module.exports = { validatePassword, parseArgs };
