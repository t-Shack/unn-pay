'use strict';

const { UniqueConstraintError } = require('sequelize');
const { IdempotencyKey } = require('../models');
const { sha256 } = require('../lib/hmac');
const { ConflictError, BadRequestError } = require('../lib/errors');
const { logger } = require('../config/logger');
const asyncHandler = require('./asyncHandler');

/**
 * Idempotency-Key support for client mutating endpoints (§9.1).
 *
 * Replaying a key returns the original response instead of performing the work
 * a second time. This is what makes a double tapped "Pay" button, or a retry
 * after a dropped connection, safe: the student gets back the reference they
 * already have rather than a second one.
 *
 * Three cases are distinguished:
 *   - key unseen        → run the handler, record the response
 *   - key completed     → replay the stored response verbatim
 *   - key in progress   → 409, because the first request has not finished yet
 *
 * A key reused with a different body is rejected outright: that is a client bug,
 * and silently returning the first response would hide it.
 */

const KEY_TTL_HOURS = 24;
const HEADER = 'idempotency-key';

function requestFingerprint(req) {
  return sha256(JSON.stringify({ body: req.body ?? null }));
}

/**
 * @param {{scope: string, required?: boolean}} options
 */
module.exports = function idempotency({ scope, required = false }) {
  return asyncHandler(async (req, res, next) => {
    const key = req.get(HEADER);

    if (!key) {
      if (required) {
        throw new BadRequestError('An Idempotency-Key header is required', 'idempotency_key_required');
      }
      return next();
    }
    if (key.length > 255) {
      throw new BadRequestError('Idempotency-Key is too long', 'idempotency_key_too_long');
    }
    if (!req.actor) {
      throw new BadRequestError(
        'Idempotency-Key requires an authenticated request',
        'idempotency_requires_auth'
      );
    }

    const where = {
      key,
      scope,
      subject_type: req.actor.type,
      subject_id: req.actor.id,
    };
    const fingerprint = requestFingerprint(req);

    const existing = await IdempotencyKey.findOne({ where });
    if (existing) {
      if (existing.request_hash !== fingerprint) {
        throw new ConflictError(
          'This Idempotency-Key has already been used with a different request body',
          'idempotency_key_reused'
        );
      }
      if (existing.status === 'completed') {
        logger.info({ scope, key }, 'replaying idempotent response');
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(existing.response_status).json(existing.response_body);
      }
      throw new ConflictError(
        'A request with this Idempotency-Key is still in progress',
        'idempotency_key_in_progress'
      );
    }

    let record;
    try {
      record = await IdempotencyKey.create({
        ...where,
        request_hash: fingerprint,
        status: 'in_progress',
        expires_at: new Date(Date.now() + KEY_TTL_HOURS * 60 * 60 * 1000),
      });
    } catch (error) {
      // Two genuinely simultaneous requests with the same key: the unique
      // constraint decides which one does the work.
      if (error instanceof UniqueConstraintError) {
        throw new ConflictError(
          'A request with this Idempotency-Key is still in progress',
          'idempotency_key_in_progress'
        );
      }
      throw error;
    }

    // Capture the response so a replay can return it byte for byte. Only a
    // successful response is stored: a failure should be retryable.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        record
          .update({ status: 'completed', response_status: res.statusCode, response_body: body })
          .catch((error) => logger.error({ err: error.message }, 'failed to store idempotent response'));
      } else {
        // Release the key so the client can legitimately retry.
        record.destroy().catch(() => {});
      }
      return originalJson(body);
    };

    return next();
  });
};

module.exports.HEADER = HEADER;
module.exports.KEY_TTL_HOURS = KEY_TTL_HOURS;
