'use strict';

const express = require('express');
const { z } = require('zod');
const receiptService = require('../../services/receiptService');
const { renderVerificationPage } = require('./verificationPage');
const asyncHandler = require('../../middleware/asyncHandler');
const validate = require('../../middleware/validate');
const { verificationLimiter } = require('../../middleware/rateLimit');

/**
 * Public receipt verification (§8, §11.7).
 *
 * No authentication, rate limited, and returns nothing beyond the fields the
 * specification permits: student name, matric number, fee item, amount, date,
 * and a clear valid or invalid state.
 *
 * The same code is served two ways from one route: an HTML page for a person who
 * scanned the QR code with a phone camera, and JSON for the mobile app and the
 * admin dashboard.
 */
const router = express.Router();

const codeParam = z.object({ code: z.string().trim().min(4).max(24) });

router.get(
  '/verify/:code',
  verificationLimiter,
  validate({ params: codeParam }),
  asyncHandler(async (req, res) => {
    const result = await receiptService.verifyByCode(req.params.code);

    // A verification result must never be cached: a receipt can be invalidated.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex');

    if (req.accepts(['html', 'json']) === 'html') {
      return res
        .status(result.valid ? 200 : 404)
        .type('html')
        .send(renderVerificationPage(result, req.params.code));
    }

    return res.status(result.valid ? 200 : 404).json(result);
  })
);

module.exports = router;
