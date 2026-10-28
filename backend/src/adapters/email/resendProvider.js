'use strict';

const { Resend } = require('resend');
const templates = require('./templates');
const config = require('../../config');
const { logger } = require('../../config/logger');

/**
 * Resend implementation of the EmailProvider interface (§3.2).
 *
 * Every method throws on failure rather than swallowing it, because the caller
 * is always the outbox worker: a throw becomes a retry with backoff, and a
 * Resend outage delays an email rather than failing a payment or an activation.
 */
class ResendProvider {
  constructor({ client } = {}) {
    this.client = client || new Resend(config.RESEND_API_KEY);
    this.from = config.EMAIL_FROM;
  }

  get name() {
    return 'resend';
  }

  async _send(to, { subject, html, text }) {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: [to],
      subject,
      html,
      text,
    });

    if (error) {
      // The message is safe to log; the body is not, and is never included.
      throw new Error(`Resend rejected the message: ${error.message || JSON.stringify(error)}`);
    }

    logger.info({ provider: 'resend', message_id: data && data.id, subject }, 'email sent');
    return { id: data && data.id };
  }

  sendActivationOtp(payload) {
    return this._send(payload.email, templates.activationOtp(payload));
  }

  sendPasswordResetOtp(payload) {
    return this._send(payload.email, templates.passwordResetOtp(payload));
  }

  sendUnappliedPaymentAlert(payload) {
    return this._send(payload.email, templates.unappliedPaymentNotice(payload));
  }

  sendBursaryAlert(payload) {
    return this._send(config.BURSARY_ALERT_EMAIL, templates.bursaryUnappliedAlert(payload));
  }

  sendPaymentSuccessful(payload) {
    return this._send(payload.email, templates.paymentSuccessful(payload));
  }
}

module.exports = { ResendProvider };
