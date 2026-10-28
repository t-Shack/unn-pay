'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { Student, AuthToken, AdminUser, sequelize } = require('../../models');
const { hashSecret, verifySecret, verifyWithTimingEqualiser } = require('../../lib/hash');
const tokenService = require('../../services/tokenService');
const outboxService = require('../../services/outboxService');
const audit = require('../../services/auditService');
const {
  UnauthorizedError,
  BadRequestError,
  ConflictError,
  TooManyRequestsError,
} = require('../../lib/errors');
const { logger } = require('../../config/logger');

/**
 * Student and admin authentication (§11.1).
 *
 * Registration is not open. A student can only activate an account if Bursary
 * has already imported their matric number, which is what makes matric
 * verification real rather than decorative.
 *
 * Two rules shape almost every function here:
 *
 *  - Never reveal whether an identifier exists. Activation and password reset
 *    return the same response whether or not the student is known, so the API
 *    cannot be used to enumerate matric numbers.
 *  - Never send email inline. Every message goes through the outbox (§9.3), so
 *    a provider outage delays an email rather than failing an activation.
 */

const OTP_TTL_MINUTES = AuthToken.TTL_MINUTES; // 15
const OTP_MAX_ATTEMPTS = AuthToken.MAX_ATTEMPTS; // 5
const MIN_PASSWORD_LENGTH = 8;

/** Six digits, uniform, from a CSPRNG. */
function generateOtp() {
  // 0 .. 999999 without modulo bias: reject the tail above the largest multiple.
  const limit = 1000000;
  const max = Math.floor(0xffffffff / limit) * limit;
  let value;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= max);
  return String(value % limit).padStart(6, '0');
}

function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      'weak_password'
    );
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new BadRequestError(
      'Password must contain at least one letter and one number',
      'weak_password'
    );
  }
}

/**
 * Issue an OTP for a purpose, invalidating any outstanding one so only the most
 * recent code ever works.
 */
async function issueOtp(student, purpose, { transaction } = {}) {
  const code = generateOtp();
  const codeHash = await hashSecret(code);

  await AuthToken.update(
    { consumed_at: new Date() },
    {
      where: { student_id: student.student_id, purpose, consumed_at: null },
      transaction,
    }
  );

  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  await AuthToken.create(
    {
      student_id: student.student_id,
      purpose,
      code_hash: codeHash,
      expires_at: expiresAt,
    },
    { transaction }
  );

  return { code, expiresAt };
}

/**
 * Step 1 of activation. Always reports success, whether or not the matric
 * number is known.
 */
async function requestActivation({ matricNumber, ipAddress }) {
  const student = await Student.findOne({ where: { matric_number: matricNumber } });

  const genericResponse = {
    message:
      'If that matric number is registered with the Bursary, an activation code has been sent to the email address on file.',
    otp_expires_in_minutes: OTP_TTL_MINUTES,
  };

  if (!student) {
    logger.info({ matric_number: matricNumber }, 'activation requested for unknown matric number');
    return genericResponse;
  }
  if (student.status === 'suspended') return genericResponse;
  if (student.status === 'active') {
    // Already activated: still generic, but nudge toward the right flow.
    return {
      ...genericResponse,
      message:
        'If that matric number is registered, you will receive an email. If your account is already active, sign in or use forgot password.',
    };
  }

  await sequelize.transaction(async (t) => {
    const { code, expiresAt } = await issueOtp(student, AuthToken.PURPOSE.ACTIVATION, {
      transaction: t,
    });
    await outboxService.enqueue(
      'email.activation_otp',
      {
        student_id: student.student_id,
        email: student.email,
        full_name: student.full_name,
        matric_number: student.matric_number,
        code,
        expires_at: expiresAt.toISOString(),
        expires_in_minutes: OTP_TTL_MINUTES,
      },
      { transaction: t }
    );
  });

  logger.info({ student_id: student.student_id }, 'activation OTP queued');
  return genericResponse;
}

/**
 * Verify an OTP, counting attempts so a six digit code cannot be brute forced.
 *
 * Attempt accounting deliberately does NOT run inside the caller's transaction.
 * A failed attempt ends in a thrown error, and throwing out of a managed
 * transaction rolls it back — which would roll back the very increment that
 * limits the attacker. Counted attempts must survive the rejection that
 * produced them, so they are committed on their own.
 *
 * Consuming the code on success is a different matter and does belong to the
 * caller's transaction: the code must be spent if and only if the activation or
 * reset it authorises actually commits.
 */
async function verifyOtp({ student, purpose, code }) {
  const authToken = await AuthToken.findOne({
    where: {
      student_id: student.student_id,
      purpose,
      consumed_at: null,
      expires_at: { [Op.gt]: new Date() },
    },
    order: [['created_at', 'DESC']],
  });

  if (!authToken) {
    throw new BadRequestError('That code is invalid or has expired', 'invalid_or_expired_code');
  }

  if (authToken.attempt_count >= OTP_MAX_ATTEMPTS) {
    // Burn the code outright: five wrong guesses means this one is finished.
    await authToken.update({ consumed_at: new Date() });
    throw new TooManyRequestsError(
      'Too many incorrect attempts. Request a new code.',
      'otp_attempts_exhausted'
    );
  }

  const matches = await verifySecret(code, authToken.code_hash);

  if (!matches) {
    // A single atomic increment, committed immediately, so concurrent guesses
    // cannot both read the same count and each think they were the first. The
    // count is then read back rather than inferred, because the increment's
    // return shape is dialect dependent and the number reported to the caller
    // has to be the number actually stored.
    const [[row]] = await sequelize.query(
      `UPDATE auth_tokens
          SET attempt_count = attempt_count + 1,
              updated_at    = CURRENT_TIMESTAMP
        WHERE token_id = :tokenId
    RETURNING attempt_count`,
      { replacements: { tokenId: authToken.token_id } }
    );

    const used = row ? Number(row.attempt_count) : authToken.attempt_count + 1;
    const remaining = Math.max(0, OTP_MAX_ATTEMPTS - used);

    if (remaining === 0) await authToken.update({ consumed_at: new Date() });

    throw new BadRequestError(
      remaining > 0
        ? `That code is incorrect. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'That code is incorrect and this code is now invalid. Request a new one.',
      'invalid_code'
    );
  }

  return authToken;
}

/**
 * Mark a verified code as spent, inside the caller's transaction. Re-checks
 * under a row lock so the same code cannot be spent twice concurrently.
 */
async function consumeOtp({ student, purpose, code, transaction }) {
  const authToken = await verifyOtp({ student, purpose, code });

  const locked = await AuthToken.findOne({
    where: { token_id: authToken.token_id, consumed_at: null },
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });

  if (!locked) {
    throw new BadRequestError('That code has already been used', 'code_already_used');
  }

  await locked.update({ consumed_at: new Date() }, { transaction });
  return locked;
}

/** Step 2 of activation: OTP plus a chosen password. */
async function confirmActivation({ matricNumber, code, password, userAgent, ipAddress }) {
  assertPasswordStrength(password);

  const student = await Student.scope('withSecrets').findOne({
    where: { matric_number: matricNumber },
  });
  if (!student) {
    throw new BadRequestError('That code is invalid or has expired', 'invalid_or_expired_code');
  }
  if (student.status === 'suspended') {
    throw new UnauthorizedError('This account is suspended. Contact the Bursary.', 'account_suspended');
  }
  if (student.status === 'active') {
    throw new ConflictError('This account is already active. Please sign in.', 'already_active');
  }

  const passwordHash = await hashSecret(password);

  const tokens = await sequelize.transaction(async (t) => {
    await consumeOtp({
      student,
      purpose: AuthToken.PURPOSE.ACTIVATION,
      code,
      transaction: t,
    });

    const before = { status: student.status };
    await student.update({ password_hash: passwordHash, status: 'active' }, { transaction: t });

    await audit.record({
      actorType: audit.ACTOR.STUDENT,
      actorId: student.student_id,
      action: audit.ACTION.STUDENT_ACTIVATED,
      entityType: 'student',
      entityId: student.student_id,
      before,
      after: { status: 'active' },
      ipAddress,
      transaction: t,
    });

    return tokenService.issueTokenPair(
      {
        subjectType: 'student',
        subjectId: student.student_id,
        extra: { matric: student.matric_number },
        userAgent,
        ipAddress,
      },
      { transaction: t }
    );
  });

  return { student: student.toPublicJSON(), tokens };
}

/** Student login. */
async function login({ matricNumber, password, userAgent, ipAddress }) {
  const student = await Student.scope('withSecrets').findOne({
    where: { matric_number: matricNumber },
  });

  // Same failure and the same cost whether the account exists, is unactivated,
  // or the password is simply wrong.
  const ok = await verifyWithTimingEqualiser(password, student ? student.password_hash : null);
  if (!student || !ok) {
    throw new UnauthorizedError('Incorrect matric number or password', 'invalid_credentials');
  }
  if (student.status === 'suspended') {
    throw new UnauthorizedError('This account is suspended. Contact the Bursary.', 'account_suspended');
  }
  if (student.status !== 'active') {
    throw new UnauthorizedError(
      'This account has not been activated yet. Activate it first.',
      'account_not_activated'
    );
  }

  const tokens = await tokenService.issueTokenPair({
    subjectType: 'student',
    subjectId: student.student_id,
    extra: { matric: student.matric_number },
    userAgent,
    ipAddress,
  });

  return { student: student.toPublicJSON(), tokens };
}

async function refresh({ refreshToken, userAgent, ipAddress }) {
  const { tokens } = await tokenService.rotateRefreshToken({
    token: refreshToken,
    subjectType: 'student',
    userAgent,
    ipAddress,
  });
  return tokens;
}

async function logout({ refreshToken }) {
  const revoked = await tokenService.revokeRefreshToken(refreshToken, { reason: 'logout' });
  return { revoked };
}

/** Forgot password. Always generic, for the same enumeration reason. */
async function forgotPassword({ matricNumber }) {
  const student = await Student.findOne({ where: { matric_number: matricNumber } });

  const genericResponse = {
    message:
      'If that matric number is registered and active, a password reset code has been sent to the email address on file.',
    otp_expires_in_minutes: OTP_TTL_MINUTES,
  };

  if (!student || student.status !== 'active') return genericResponse;

  await sequelize.transaction(async (t) => {
    const { code, expiresAt } = await issueOtp(student, AuthToken.PURPOSE.PASSWORD_RESET, {
      transaction: t,
    });
    await outboxService.enqueue(
      'email.password_reset_otp',
      {
        student_id: student.student_id,
        email: student.email,
        full_name: student.full_name,
        code,
        expires_at: expiresAt.toISOString(),
        expires_in_minutes: OTP_TTL_MINUTES,
      },
      { transaction: t }
    );
  });

  return genericResponse;
}

async function resetPassword({ matricNumber, code, password, ipAddress }) {
  assertPasswordStrength(password);

  const student = await Student.scope('withSecrets').findOne({
    where: { matric_number: matricNumber },
  });
  if (!student || student.status !== 'active') {
    throw new BadRequestError('That code is invalid or has expired', 'invalid_or_expired_code');
  }

  const passwordHash = await hashSecret(password);

  await sequelize.transaction(async (t) => {
    await consumeOtp({
      student,
      purpose: AuthToken.PURPOSE.PASSWORD_RESET,
      code,
      transaction: t,
    });
    await student.update({ password_hash: passwordHash }, { transaction: t });

    // A password change ends every existing session, on every device.
    await tokenService.revokeAllForSubject('student', student.student_id, {
      reason: 'password_reset',
      transaction: t,
    });

    await audit.record({
      actorType: audit.ACTOR.STUDENT,
      actorId: student.student_id,
      action: audit.ACTION.STUDENT_PASSWORD_RESET,
      entityType: 'student',
      entityId: student.student_id,
      ipAddress,
      transaction: t,
    });
  });

  return { message: 'Your password has been reset. Please sign in.' };
}

// --- admin -----------------------------------------------------------------

/** Admin login (§11.6). There is no public admin registration endpoint, ever. */
async function adminLogin({ email, password, userAgent, ipAddress }) {
  const admin = await AdminUser.scope('withSecrets').findOne({
    where: { email: String(email || '').toLowerCase() },
  });

  const ok = await verifyWithTimingEqualiser(password, admin ? admin.password_hash : null);

  if (!admin || !ok || !admin.is_active) {
    if (admin) {
      await audit.record({
        actorType: audit.ACTOR.ADMIN,
        actorId: admin.admin_id,
        action: audit.ACTION.ADMIN_LOGIN_FAILED,
        entityType: 'admin_user',
        entityId: admin.admin_id,
        ipAddress,
      });
    }
    throw new UnauthorizedError('Incorrect email or password', 'invalid_credentials');
  }

  await admin.update({ last_login_at: new Date() });

  const tokens = await tokenService.issueTokenPair({
    subjectType: 'admin',
    subjectId: admin.admin_id,
    extra: { role: admin.role },
    userAgent,
    ipAddress,
  });

  await audit.record({
    actorType: audit.ACTOR.ADMIN,
    actorId: admin.admin_id,
    action: audit.ACTION.ADMIN_LOGIN,
    entityType: 'admin_user',
    entityId: admin.admin_id,
    ipAddress,
  });

  return { admin: admin.toPublicJSON(), tokens };
}

async function adminRefresh({ refreshToken, userAgent, ipAddress }) {
  const { tokens } = await tokenService.rotateRefreshToken({
    token: refreshToken,
    subjectType: 'admin',
    userAgent,
    ipAddress,
  });
  return tokens;
}

module.exports = {
  requestActivation,
  confirmActivation,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  adminLogin,
  adminRefresh,
  generateOtp,
  issueOtp,
  verifyOtp,
  consumeOtp,
  assertPasswordStrength,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
};
