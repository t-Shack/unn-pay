'use strict';

const express = require('express');
const service = require('./service');
const asyncHandler = require('../../middleware/asyncHandler');
const { logger } = require('../../config/logger');

/**
 * Bank webhook endpoint (§11.4).
 *
 * Mounted with a raw body parser, never the JSON parser: signature verification
 * runs over the exact bytes the bank signed, and re-serialising parsed JSON
 * changes whitespace and key order, which breaks every signature scheme there
 * is.
 */
const router = express.Router();

router.post(
  '/bank',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const result = await service.handleInboundWebhook({
      rawBody: req.body,
      headers: req.headers,
      ipAddress: req.ip,
    });

    logger.info(
      { outcome: result.outcome, settlement_outcome: result.settlementOutcome },
      'bank webhook handled'
    );

    res.status(result.status).json({
      received: result.status === 200,
      outcome: result.outcome,
      reason: result.reason,
    });
  })
);

module.exports = router;
