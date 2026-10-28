'use strict';

const templates = require('./templates');
const config = require('../../config');
const { logger } = require('../../config/logger');

/**
 * Development and test implementation of the EmailProvider interface.
 *
 * Nothing leaves the machine. Messages are logged, and kept in memory so tests
 * can assert on what would have been sent — including the OTP, which is
 * otherwise unreachable because it is bcrypt hashed at rest.
 *
 * This is also the guard the specification asks for in §3.2: local development
 * never points at the production sending domain, because it never sends at all.
 */
class ConsoleEmailProvider {
  constructor() {
    this.sent = [];
  }

  get name() {
    return 'console';
  }

  _record(to, kind, rendered, payload) {
    const entry = { to, kind, subject: rendered.subject, text: rendered.text, payload, at: new Date() };
    this.sent.push(entry);
    // Cap the buffer so a long running dev server cannot grow without bound.
    if (this.sent.length > 500) this.sent.shift();
    logger.info({ to, kind, subject: rendered.subject }, 'email (not sent; console provider)');
    // With nothing actually sent, a developer or a demonstration needs the code
    // from somewhere. Development only: never in test output, never in production.
    if (config.isDevelopment && payload && payload.code) {
      logger.info({ to, kind, code: payload.code }, 'one-time code (development only)');
    }
    return { id: `console-${this.sent.length}` };
  }

  /** Test helper: the most recent message of a kind, optionally to one address. */
  lastOfKind(kind, to) {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const entry = this.sent[i];
      if (entry.kind === kind && (!to || entry.to === to)) return entry;
    }
    return null;
  }

  clear() {
    this.sent = [];
  }

  async sendActivationOtp(payload) {
    return this._record(payload.email, 'activation_otp', templates.activationOtp(payload), payload);
  }

  async sendPasswordResetOtp(payload) {
    return this._record(
      payload.email,
      'password_reset_otp',
      templates.passwordResetOtp(payload),
      payload
    );
  }

  async sendUnappliedPaymentAlert(payload) {
    return this._record(
      payload.email,
      'unapplied_payment',
      templates.unappliedPaymentNotice(payload),
      payload
    );
  }

  async sendBursaryAlert(payload) {
    return this._record(
      config.BURSARY_ALERT_EMAIL,
      'bursary_alert',
      templates.bursaryUnappliedAlert(payload),
      payload
    );
  }

  async sendPaymentSuccessful(payload) {
    return this._record(
      payload.email,
      'payment_successful',
      templates.paymentSuccessful(payload),
      payload
    );
  }
}

module.exports = { ConsoleEmailProvider };
