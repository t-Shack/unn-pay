'use strict';

/**
 * Application errors carry an HTTP status, a stable machine readable code that
 * clients can branch on, and optional non sensitive details. Anything thrown
 * that is not an AppError is treated as a bug and reported as a 500 with no
 * internal detail leaked to the caller.
 */
class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details = undefined, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = status < 500;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details) {
    super(message, { status: 422, code: 'validation_error', details });
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = 'bad_request', details) {
    super(message, { status: 400, code, details });
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'unauthorized') {
    super(message, { status: 401, code });
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Not permitted', code = 'forbidden') {
    super(message, { status: 403, code });
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found', code = 'not_found') {
    super(message, { status: 404, code });
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'conflict', details) {
    super(message, { status: 409, code, details });
  }
}

class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', code = 'rate_limited', details) {
    super(message, { status: 429, code, details });
  }
}

/** The bank adapter is unreachable or failing; distinct from our own bugs. */
class BankUnavailableError extends AppError {
  constructor(message = 'Bank service unavailable', { code = 'bank_unavailable', cause } = {}) {
    super(message, { status: 503, code, cause });
  }
}

module.exports = {
  AppError,
  ValidationError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  TooManyRequestsError,
  BankUnavailableError,
};
