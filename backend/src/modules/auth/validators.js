'use strict';

const { z } = require('zod');

/**
 * Every field that reaches an auth controller is validated here first (§11).
 * Matric numbers are checked against the format the specification fixes,
 * NNNN/NNNNNN, so a malformed one never reaches a database query.
 */

const matricNumber = z
  .string()
  .trim()
  .regex(/^\d{4}\/\d{6}$/, 'Matric number must look like 2022/248400');

const otpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'The code is six digits');

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

const refreshToken = z.string().min(20, 'Refresh token is required').max(512);

module.exports = {
  activateRequest: z.object({ matric_number: matricNumber }),
  activateConfirm: z.object({
    matric_number: matricNumber,
    code: otpCode,
    password,
  }),
  login: z.object({ matric_number: matricNumber, password: z.string().min(1).max(128) }),
  refresh: z.object({ refresh_token: refreshToken }),
  logout: z.object({ refresh_token: refreshToken }),
  forgotPassword: z.object({ matric_number: matricNumber }),
  resetPassword: z.object({
    matric_number: matricNumber,
    code: otpCode,
    password,
  }),
  adminLogin: z.object({
    email: z.string().trim().email('A valid email address is required').max(100),
    password: z.string().min(1).max(128),
  }),
  matricNumber,
  otpCode,
  password,
};
