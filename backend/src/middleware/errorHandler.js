'use strict';

const { ValidationError: SequelizeValidationError, UniqueConstraintError } = require('sequelize');
const { AppError } = require('../lib/errors');
const { logger } = require('../config/logger');
const { captureException } = require('../config/sentry');
const config = require('../config');

/**
 * The single place an error becomes an HTTP response.
 *
 * Two rules:
 *  - a caller learns what they did wrong, and nothing about our internals
 *  - anything unexpected is logged in full, reported to Sentry with the
 *    correlation id attached, and returned as an opaque 500
 */
module.exports = function errorHandler(error, req, res, _next) {
  const correlationId = req.correlationId;

  let status = 500;
  let code = 'internal_error';
  let message = 'Something went wrong on our side. Please try again.';
  let details;

  if (error instanceof AppError) {
    ({ status, code, message, details } = error);
  } else if (error instanceof UniqueConstraintError) {
    status = 409;
    code = 'conflict';
    message = 'That record already exists';
  } else if (error instanceof SequelizeValidationError) {
    status = 422;
    code = 'validation_error';
    message = 'Some of the details you sent are not valid';
    details = error.errors.map((e) => ({ field: e.path, message: e.message }));
  } else if (error.type === 'entity.parse.failed') {
    status = 400;
    code = 'malformed_json';
    message = 'The request body is not valid JSON';
  } else if (error.type === 'entity.too.large') {
    status = 413;
    code = 'payload_too_large';
    message = 'The request body is too large';
  } else if (error.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    code = 'file_too_large';
    message = 'That file is too large';
  }

  const logPayload = {
    err: { message: error.message, name: error.name, code: error.code },
    status,
    method: req.method,
    path: req.originalUrl,
  };

  if (status >= 500) {
    logger.error({ ...logPayload, stack: error.stack }, 'request failed');
    captureException(error, { correlationId, method: req.method, path: req.originalUrl });
  } else {
    logger.warn(logPayload, 'request rejected');
  }

  const body = { error: { code, message, correlation_id: correlationId } };
  if (details) body.error.details = details;
  // A stack trace is a development aid, never part of a production response.
  if (!config.isProduction && status >= 500) body.error.stack = error.stack;

  res.status(status).json(body);
};
