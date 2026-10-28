'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { BankCollectionAdapter } = require('./BankCollectionAdapter');
const { normaliseSettlement, PAYMENT_CHANNELS } = require('./types');
const { koboToDecimalString, toKobo } = require('../../lib/money');
const { safeEqual } = require('../../lib/hmac');
const config = require('../../config');

/**
 * SandboxAdapter — a deterministic simulation of a partner bank (§5).
 *
 * Development, the automated test suite, and demos run entirely against this.
 * It simulates the full lifecycle: minting, successful settlement, under and
 * overpayment, duplicate delivery, late webhooks, unknown references, and hard
 * failures. Every behaviour is deterministic and driven either by an explicit
 * call or by a programmed fault, never by chance, so a failing test always
 * reproduces.
 *
 * State lives in the database rather than in memory because the API and the
 * worker are separate processes (§4): the worker's reconciliation sweep has to
 * be able to see a settlement the API never heard about, which is exactly the
 * scenario the sweep exists for.
 *
 * Webhook signature scheme (this adapter's own; a real bank defines its own
 * inside its own adapter):
 *   header  x-bank-signature: t=<unix seconds>,v1=<hex hmac>
 *   message `${t}.${rawBody}` signed with BANK_WEBHOOK_SECRET
 */

const SANDBOX_BANK_NAME = 'UNN Pay Sandbox Bank';
const SIGNATURE_HEADER = 'x-bank-signature';

class SandboxAdapter extends BankCollectionAdapter {
  /**
   * @param {{models?: object, webhookSecret?: string, clock?: () => Date}} [options]
   */
  constructor({ models, webhookSecret, clock } = {}) {
    super();
    this._models = models;
    this._webhookSecret = webhookSecret || config.BANK_WEBHOOK_SECRET;
    this._clock = clock || (() => new Date());
    /**
     * Programmed faults, used by the failure injection suite (§14). Each entry
     * is consumed once, in order, so a test can say "fail three times then
     * succeed" without depending on wall clock timing.
     * @type {Array<{method: string, mode: 'timeout'|'error'|'malformed', message?: string}>}
     */
    this._faults = [];
  }

  get name() {
    return 'sandbox';
  }

  get displayName() {
    return SANDBOX_BANK_NAME;
  }

  get models() {
    // Resolved lazily so requiring this module never pulls in the database.
    if (!this._models) this._models = require('../../models');
    return this._models;
  }

  // --- test and demo controls ------------------------------------------------

  /**
   * Queue a fault for the next call to `method`.
   * mode 'timeout'   — rejects as a timed out request would
   * mode 'error'     — rejects immediately, as a 500 from the bank would
   * mode 'malformed' — resolves with a payload that violates the contract
   */
  injectFault(method, mode = 'error', { times = 1, message } = {}) {
    for (let i = 0; i < times; i += 1) this._faults.push({ method, mode, message });
    return this;
  }

  clearFaults() {
    this._faults = [];
    return this;
  }

  async _applyFault(method) {
    const index = this._faults.findIndex((f) => f.method === method);
    if (index === -1) return null;
    const [fault] = this._faults.splice(index, 1);
    if (fault.mode === 'timeout') {
      const error = new Error(fault.message || 'Sandbox bank timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    if (fault.mode === 'error') {
      const error = new Error(fault.message || 'Sandbox bank returned 500');
      error.status = 500;
      throw error;
    }
    return fault; // 'malformed' is handled by the caller
  }

  // --- BankCollectionAdapter -------------------------------------------------

  async mintVirtualAccount({ reference, amountKobo, payerName, expiresAt }) {
    const fault = await this._applyFault('mintVirtualAccount');

    const providerReference = `SBX-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    // A stable ten digit NUBAN shaped number, derived from the reference so the
    // same reference always maps to the same account in a demo.
    const accountNumber = `9${crypto
      .createHash('sha256')
      .update(reference)
      .digest()
      .readUInt32BE(0)
      .toString()
      .padStart(9, '0')
      .slice(0, 9)}`;

    if (fault && fault.mode === 'malformed') {
      // Deliberately violates the contract, to prove the caller validates.
      return { accountNumber: null, bankName: 42, providerReference: '', channels: 'transfer' };
    }

    await this.models.SandboxVirtualAccount.create({
      provider_reference: providerReference,
      unn_reference: reference,
      account_number: accountNumber,
      bank_name: SANDBOX_BANK_NAME,
      expected_amount: koboToDecimalString(amountKobo),
      payer_name: payerName,
      expires_at: expiresAt,
    });

    return {
      accountNumber,
      bankName: SANDBOX_BANK_NAME,
      providerReference,
      channels: [...PAYMENT_CHANNELS],
    };
  }

  verifySignature(rawBody, headers = {}) {
    const header = headers[SIGNATURE_HEADER] || headers[SIGNATURE_HEADER.toUpperCase()];
    if (!header || typeof header !== 'string') return false;

    const parts = Object.fromEntries(
      header
        .split(',')
        .map((piece) => piece.trim().split('='))
        .filter((pair) => pair.length === 2)
    );
    if (!parts.t || !parts.v1) return false;

    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) return false;

    // Replay window (§9.5). Checked here rather than in the controller because
    // the timestamp is part of this adapter's own signature scheme.
    const ageSeconds = Math.abs(Math.floor(this._clock().getTime() / 1000) - timestamp);
    if (ageSeconds > config.BANK_WEBHOOK_TOLERANCE_SECONDS) return false;

    const expected = crypto
      .createHmac('sha256', this._webhookSecret)
      .update(`${parts.t}.${Buffer.from(rawBody).toString('utf8')}`, 'utf8')
      .digest('hex');

    return safeEqual(expected, parts.v1);
  }

  parseWebhook(rawBody) {
    const payload = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    return normaliseSettlement({
      providerReference: payload.provider_reference,
      unnReference: payload.unn_reference,
      amountPaid: payload.amount_paid,
      currency: payload.currency || 'NGN',
      channel: payload.channel,
      status: payload.status,
      paidAt: payload.paid_at,
      payerAccountName: payload.payer_account_name,
      payerBank: payload.payer_bank,
      rawPayload: payload,
    });
  }

  async fetchSettlement(providerReference) {
    await this._applyFault('fetchSettlement');
    const row = await this.models.SandboxSettlement.findOne({
      where: { provider_reference: providerReference },
    });
    return row ? this._toSettlement(row) : null;
  }

  /**
   * Look a settlement up by the UNN reference rather than the provider's.
   * Reconciliation needs this when a mint succeeded at the bank but its response
   * never reached us, so we hold no provider reference at all.
   */
  async fetchSettlementByReference(unnReference) {
    await this._applyFault('fetchSettlement');
    const row = await this.models.SandboxSettlement.findOne({
      where: { unn_reference: unnReference },
      order: [['paid_at', 'DESC']],
    });
    return row ? this._toSettlement(row) : null;
  }

  async listSettlements({ from, to, cursor, limit = 200 } = {}) {
    await this._applyFault('listSettlements');
    const where = { paid_at: { [Op.gte]: from, [Op.lte]: to } };
    if (cursor) where.sandbox_settlement_id = { [Op.gt]: Number(cursor) };

    const rows = await this.models.SandboxSettlement.findAll({
      where,
      order: [['sandbox_settlement_id', 'ASC']],
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => this._toSettlement(row)),
      nextCursor: hasMore ? String(page[page.length - 1].sandbox_settlement_id) : undefined,
    };
  }

  async healthCheck() {
    await this.models.sequelize.query('SELECT 1');
    return { ok: true, detail: 'sandbox adapter ready' };
  }

  async releaseVirtualAccount(providerReference) {
    const [count] = await this.models.SandboxVirtualAccount.update(
      { released_at: this._clock() },
      { where: { provider_reference: providerReference, released_at: null } }
    );
    return { released: count > 0 };
  }

  // --- simulation ------------------------------------------------------------

  /**
   * Simulate money arriving. Returns the settlement plus a ready to post,
   * correctly signed webhook envelope, so a test or a demo can choose whether
   * the webhook is delivered, delivered twice, or never delivered at all.
   *
   * @param {Object} params
   * @param {string} params.unnReference
   * @param {number} [params.amountKobo]  defaults to the minted expectation
   * @param {'exact'|'underpayment'|'overpayment'} [params.scenario]
   */
  async simulatePayment({
    unnReference,
    amountKobo,
    scenario = 'exact',
    channel = 'transfer',
    status = 'successful',
    payerAccountName = 'SIMULATED PAYER',
    payerBank = 'Sandbox Bank',
    paidAt,
    providerReference,
  }) {
    const account = await this.models.SandboxVirtualAccount.findOne({
      where: { unn_reference: unnReference },
    });

    // An unknown reference is a legitimate scenario: money genuinely arrives
    // quoting a reference UNN never minted (§10).
    const expectedKobo = account ? toKobo(account.expected_amount) : null;

    let finalKobo = amountKobo;
    if (finalKobo === undefined || finalKobo === null) {
      if (expectedKobo === null) {
        throw new Error(
          `simulatePayment needs an explicit amountKobo for unminted reference ${unnReference}`
        );
      }
      if (scenario === 'underpayment') finalKobo = Math.max(0, expectedKobo - 100000);
      else if (scenario === 'overpayment') finalKobo = expectedKobo + 100000;
      else finalKobo = expectedKobo;
    }

    const settlement = await this.models.SandboxSettlement.create({
      provider_reference:
        providerReference || `SBX-STL-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      unn_reference: unnReference,
      account_number: account ? account.account_number : null,
      amount_paid: koboToDecimalString(finalKobo),
      channel,
      status,
      payer_account_name: payerAccountName,
      payer_bank: payerBank,
      paid_at: paidAt || this._clock(),
    });

    return {
      settlement: this._toSettlement(settlement),
      webhook: this.buildSignedWebhook(settlement),
    };
  }

  /** Build the exact signed HTTP envelope the sandbox bank would send. */
  buildSignedWebhook(row, { timestamp } = {}) {
    const body = JSON.stringify({
      event: 'settlement.completed',
      provider_reference: row.provider_reference,
      unn_reference: row.unn_reference,
      amount_paid: koboToDecimalString(toKobo(row.amount_paid)),
      currency: 'NGN',
      channel: row.channel,
      status: row.status,
      paid_at: new Date(row.paid_at).toISOString(),
      payer_account_name: row.payer_account_name,
      payer_bank: row.payer_bank,
    });
    const t = timestamp || Math.floor(this._clock().getTime() / 1000);
    const signature = crypto
      .createHmac('sha256', this._webhookSecret)
      .update(`${t}.${body}`, 'utf8')
      .digest('hex');
    return { body, headers: { [SIGNATURE_HEADER]: `t=${t},v1=${signature}` } };
  }

  _toSettlement(row) {
    return normaliseSettlement({
      providerReference: row.provider_reference,
      unnReference: row.unn_reference,
      amountPaid: row.amount_paid,
      currency: 'NGN',
      channel: row.channel,
      status: row.status,
      paidAt: row.paid_at,
      payerAccountName: row.payer_account_name,
      payerBank: row.payer_bank,
      rawPayload: {
        source: 'sandbox',
        provider_reference: row.provider_reference,
        unn_reference: row.unn_reference,
        amount_paid: row.amount_paid,
        channel: row.channel,
        status: row.status,
        paid_at: row.paid_at,
      },
    });
  }
}

module.exports = { SandboxAdapter, SANDBOX_BANK_NAME, SIGNATURE_HEADER };
