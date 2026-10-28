'use strict';

const pino = require('pino');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./index');

/**
 * Structured JSON logging with a correlation id threaded through every request
 * (§9.6) and hard redaction of anything sensitive (§13.10).
 */

const requestContext = new AsyncLocalStorage();

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-bank-signature"]',
  'req.body.password',
  'req.body.new_password',
  'req.body.current_password',
  'req.body.code',
  'req.body.otp',
  'req.body.refresh_token',
  'password',
  'new_password',
  'code_hash',
  'password_hash',
  'otp',
  'token',
  'access_token',
  'refresh_token',
  'signature',
  'payerAccountNumber',
  'payer_account_number',
  '*.password',
  '*.otp',
  '*.access_token',
  '*.refresh_token',
  '*.password_hash',
  '*.code_hash',
];

const logger = pino({
  level: config.isTest ? process.env.LOG_LEVEL || 'silent' : config.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME || 'unn-pay-api', env: config.NODE_ENV },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Every log line carries the correlation id of the request that produced it,
  // including lines emitted deep inside services that never see the request.
  mixin() {
    const store = requestContext.getStore();
    return store && store.correlationId ? { correlationId: store.correlationId } : {};
  },
});

/** Mask an account number to its last four digits: 0123456789 -> ******6789. */
function maskAccountNumber(value) {
  if (!value) return value;
  const str = String(value);
  if (str.length <= 4) return '*'.repeat(str.length);
  return '*'.repeat(str.length - 4) + str.slice(-4);
}

module.exports = {
  logger,
  requestContext,
  maskAccountNumber,
  getCorrelationId: () => {
    const store = requestContext.getStore();
    return store ? store.correlationId : undefined;
  },
};
