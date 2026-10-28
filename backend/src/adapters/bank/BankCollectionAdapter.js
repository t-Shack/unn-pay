'use strict';

/**
 * The single interface through which UNN Pay talks to a bank (§5).
 *
 * No business logic anywhere else in this codebase may import a bank SDK, know a
 * bank's name, or parse a bank specific payload. Adding a second bank means
 * writing one new subclass and changing one environment variable; if a bank swap
 * ever requires touching a service or a controller, that is a defect in this
 * build.
 *
 * Every method that talks to the network may throw; the resilient wrapper
 * (see resilientAdapter.js) turns repeated failures into an open circuit rather
 * than letting them reach a student as a hard error.
 */
class BankCollectionAdapter {
  /** Short machine name, persisted on each transaction so a future router can pick per transaction. */
  get name() {
    throw new Error('Adapter must define a name');
  }

  /** Human readable label for dashboards. */
  get displayName() {
    return this.name;
  }

  /**
   * Mint a virtual account bound to one UNN Payment Reference.
   * @param {{reference: string, amountKobo: number, payerName: string, expiresAt: Date, metadata?: object}} _params
   * @returns {Promise<{accountNumber: string, bankName: string, providerReference: string, channels: string[]}>}
   */
  // eslint-disable-next-line no-unused-vars
  async mintVirtualAccount(_params) {
    throw new Error('mintVirtualAccount is not implemented');
  }

  /**
   * Verify a webhook signature against the raw request body. Called before any
   * database write (§9.5). Must be constant time.
   * @param {Buffer} _rawBody
   * @param {Record<string,string>} _headers
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  verifySignature(_rawBody, _headers) {
    throw new Error('verifySignature is not implemented');
  }

  /**
   * Parse a webhook body into the normalised shape.
   * @param {Buffer} _rawBody
   * @returns {import('./types').NormalisedSettlement}
   */
  // eslint-disable-next-line no-unused-vars
  parseWebhook(_rawBody) {
    throw new Error('parseWebhook is not implemented');
  }

  /**
   * Look up one settlement by the bank's own reference. Used by reconciliation
   * to recover a webhook that never arrived.
   * @param {string} _providerReference
   * @returns {Promise<import('./types').NormalisedSettlement | null>}
   */
  // eslint-disable-next-line no-unused-vars
  async fetchSettlement(_providerReference) {
    throw new Error('fetchSettlement is not implemented');
  }

  /**
   * List settlements in a window. This exists specifically so reconciliation
   * works when no webhook ever arrives; an adapter without it is unusable (§5).
   * @param {{from: Date, to: Date, cursor?: string}} _params
   * @returns {Promise<{items: import('./types').NormalisedSettlement[], nextCursor?: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async listSettlements(_params) {
    throw new Error('listSettlements is not implemented');
  }

  /**
   * Optional liveness probe used by GET /health/ready.
   * @returns {Promise<{ok: boolean, detail?: string}>}
   */
  async healthCheck() {
    return { ok: true };
  }

  /** Release a virtual account when its reference expires (§6). Optional. */
  // eslint-disable-next-line no-unused-vars
  async releaseVirtualAccount(_providerReference) {
    return { released: false, reason: 'not_supported' };
  }
}

module.exports = { BankCollectionAdapter };
