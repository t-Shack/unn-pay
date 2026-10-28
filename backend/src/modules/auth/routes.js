'use strict';

const express = require('express');
const controller = require('./controller');
const validators = require('./validators');
const validate = require('../../middleware/validate');
const { requireStudent } = require('../../middleware/auth');
const { loginLimiter, otpLimiter } = require('../../middleware/rateLimit');

/**
 * Student authentication routes (§11.1).
 * Registration is not open: a student can only activate an account Bursary has
 * already imported.
 */
const router = express.Router();

router.post(
  '/activate/request',
  otpLimiter,
  validate({ body: validators.activateRequest }),
  controller.activateRequest
);

router.post(
  '/activate/confirm',
  validate({ body: validators.activateConfirm }),
  controller.activateConfirm
);

router.post('/login', loginLimiter, validate({ body: validators.login }), controller.login);
router.post('/refresh', validate({ body: validators.refresh }), controller.refresh);
router.post('/logout', validate({ body: validators.logout }), controller.logout);

router.post(
  '/forgot-password',
  otpLimiter,
  validate({ body: validators.forgotPassword }),
  controller.forgotPassword
);
router.post(
  '/reset-password',
  validate({ body: validators.resetPassword }),
  controller.resetPassword
);

router.get('/me', requireStudent, controller.me);

module.exports = router;
