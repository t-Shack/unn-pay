'use strict';

const express = require('express');
const controller = require('./controller');
const validators = require('./validators');
const validate = require('../../middleware/validate');
const idempotency = require('../../middleware/idempotency');
const { requireStudent } = require('../../middleware/auth');

/**
 * Payments (§11.3).
 *
 * `initiate` is the one mutating student endpoint, so it carries the
 * Idempotency-Key support: a double tapped Pay button returns the reference
 * already minted rather than minting a second one.
 *
 * Route order matters — /history is declared before /:reference so it is not
 * swallowed by the parameterised route.
 */
const router = express.Router();

router.use(requireStudent);

router.post(
  '/initiate',
  idempotency({ scope: 'payments:initiate' }),
  validate({ body: validators.initiate }),
  controller.initiate
);

router.get('/history', validate({ query: validators.historyQuery }), controller.history);

router.get('/:reference', validate({ params: validators.referenceParam }), controller.getByReference);

router.get(
  '/:reference/receipt',
  validate({ params: validators.referenceParam }),
  controller.receipt
);

module.exports = router;
