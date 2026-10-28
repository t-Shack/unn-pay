'use strict';

const rateLimit = require('express-rate-limit');
const { TooManyRequestsError } = require('../lib/errors');
const config = require('../config');

/**
 * Rate limits (§13.6).
 *
 *   login                 5 per 15 minutes per identifier
 *   OTP requests          3 per hour
 *   receipt verification  30 per minute per IP
 *
 * Login and OTP limits key on the identifier being attacked (the matric number
 * or email) rather than the source IP, because the attack these defend against
 * is credential stuffing from many addresses against one account. A general IP
 * limit sits in front of everything as well.
 *
 * The store is in memory, which is correct for a single instance and acceptable
 * across a small fleet where each instance enforces its own share. Moving to a
 * shared Redis store is a one line change to `store` here if UNN ever runs many
 * API instances.
 */

const handler = (message, code) => (_req, _res, next) => next(new TooManyRequestsError(message, code));

const baseOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  // The suite exercises limits explicitly; leaving them on globally would make
  // every other test order dependent.
  skip: () => config.isTest && process.env.ENABLE_RATE_LIMITS !== 'true',
};

/** Identifier the limiter counts against, falling back to the source IP. */
const identifierKey = (field) => (req) => {
  const value = req.body && req.body[field];
  return value ? `${field}:${String(value).toLowerCase()}` : `ip:${req.ip}`;
};

const loginLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: identifierKey('matric_number'),
  handler: handler('Too many sign in attempts. Try again in 15 minutes.', 'login_rate_limited'),
});

const adminLoginLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: identifierKey('email'),
  handler: handler('Too many sign in attempts. Try again in 15 minutes.', 'login_rate_limited'),
});

const otpLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000,
  limit: 3,
  keyGenerator: identifierKey('matric_number'),
  handler: handler(
    'Too many code requests. Try again in an hour, or contact the Bursary.',
    'otp_rate_limited'
  ),
});

const verificationLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 30,
  handler: handler('Too many verification attempts. Please slow down.', 'verify_rate_limited'),
});

/** Broad backstop for the authenticated API surface. */
const apiLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 240,
  handler: handler('Too many requests. Please slow down.', 'rate_limited'),
});

module.exports = {
  loginLimiter,
  adminLoginLimiter,
  otpLimiter,
  verificationLimiter,
  apiLimiter,
};
