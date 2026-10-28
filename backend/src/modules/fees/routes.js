'use strict';

const express = require('express');
const { z } = require('zod');
const paymentService = require('../../services/paymentService');
const asyncHandler = require('../../middleware/asyncHandler');
const validate = require('../../middleware/validate');
const { requireStudent } = require('../../middleware/auth');

/**
 * Fees (§11.2). Returns the fee items applicable to this student, each flagged
 * paid, pending, under review or outstanding, plus the total outstanding.
 */
const router = express.Router();

const querySchema = z.object({
  session: z
    .string()
    .regex(/^\d{4}\/\d{4}$/, 'Session must look like 2025/2026')
    .optional(),
});

router.get(
  '/',
  requireStudent,
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const result = await paymentService.listFeesForStudent(req.student, {
      session: req.validatedQuery.session,
    });
    res.status(200).json(result);
  })
);

module.exports = router;
