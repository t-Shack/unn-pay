'use strict';

const config = require('../../config');
const { logger } = require('../../config/logger');

/**
 * Email provider selection (§3.2).
 *
 * Resend is the provider, but it sits behind this thin interface for the same
 * reason the bank does: a provider change must never reach into business logic.
 * One implementation is all that is needed now.
 *
 * The interface is four methods:
 *   sendActivationOtp, sendPasswordResetOtp, sendUnappliedPaymentAlert, sendBursaryAlert
 */

let instance = null;

function get() {
  if (instance) return instance;

  if (!config.RESEND_API_KEY) {
    if (config.isProduction) {
      throw new Error('RESEND_API_KEY is required in production');
    }
    // Development and tests: log the message instead of sending it, so an
    // activation code is visible in the console and no mail ever leaves.
    const { ConsoleEmailProvider } = require('./consoleProvider');
    instance = new ConsoleEmailProvider();
    logger.warn('no RESEND_API_KEY set; emails will be logged, not sent');
    return instance;
  }

  const { ResendProvider } = require('./resendProvider');
  instance = new ResendProvider();
  return instance;
}

const resetForTests = () => {
  instance = null;
};

module.exports = { get, resetForTests };
