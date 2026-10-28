'use strict';

const { Student, AdminUser } = require('../models');
const tokenService = require('../services/tokenService');
const { UnauthorizedError, ForbiddenError } = require('../lib/errors');
const asyncHandler = require('./asyncHandler');

/**
 * Bearer token authentication.
 *
 * The token is verified, then the subject is loaded fresh from the database on
 * every request. A student suspended a minute ago must not keep working for the
 * remaining life of their access token.
 */

function bearerToken(req) {
  const header = req.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('Authentication required', 'missing_token');
  }
  return header.slice('Bearer '.length).trim();
}

const requireStudent = asyncHandler(async (req, _res, next) => {
  const payload = tokenService.verifyAccessToken(bearerToken(req), 'student');
  const student = await Student.findByPk(Number(payload.sub));

  if (!student) throw new UnauthorizedError('Account not found', 'account_not_found');
  if (student.status === 'suspended') {
    throw new ForbiddenError('This account is suspended. Contact the Bursary.', 'account_suspended');
  }
  if (student.status !== 'active') {
    throw new ForbiddenError('This account is not active', 'account_not_active');
  }

  req.student = student;
  req.actor = { type: 'student', id: student.student_id };
  next();
});

const requireAdmin = asyncHandler(async (req, _res, next) => {
  const payload = tokenService.verifyAccessToken(bearerToken(req), 'admin');
  const admin = await AdminUser.findByPk(Number(payload.sub));

  if (!admin || !admin.is_active) {
    throw new UnauthorizedError('Administrator account not found or disabled', 'admin_not_active');
  }

  req.admin = admin;
  req.actor = { type: 'admin', id: admin.admin_id };
  next();
});

/** Role gate for endpoints only a Super Admin may reach (§11.6). */
const requireSuperAdmin = (req, _res, next) => {
  if (!req.admin || req.admin.role !== AdminUser.ROLES.SUPER_ADMIN) {
    return next(new ForbiddenError('This action requires a Super Admin', 'super_admin_required'));
  }
  return next();
};

module.exports = { requireStudent, requireAdmin, requireSuperAdmin, bearerToken };
