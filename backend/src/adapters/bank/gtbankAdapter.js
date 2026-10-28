'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { BankCollectionAdapter } = require('./BankCollectionAdapter');
const { normaliseSettlement } = require('./types');
const { koboToDecimalString } = require('../../lib/money');
const { safeEqual } = require('../../lib/hmac');
const config = require('../../config');

/**
 * GTBankAdapter — the one and only file in this codebase that knows GTBank
 * exists (§5.1).
 *
 * Everything specific to this bank is confined here: its field names, its
 * status strings, its date format, its error codes, its authentication scheme,
 * and its GTBANK_* configuration. Nothing outside this file and its tests may
 * contain the string "GTB"; if a code review finds one, the abstraction has
 * failed and the promised one file bank swap is no longer true.
 *
 * ── Status of this implementation ──────────────────────────────────────────
 * GTBank's API credentials and documentation have not yet been supplied (§16),
 * so the request and response shapes below are written against the collections
 * API pattern GTBank publishes for institutional customers, and are marked at
 * each point where the real contract must be confirmed. The mapping layer, not
 * the guesswork, is the durable part: when the real documentation arrives, only
 * the marked constants and the three translate* functions change, and nothing
 * outside this file moves at all.
 *
 * Until then BANK_ADAPTER stays `sandbox` and this file is never loaded in a
 * running deployment.
 */

// ─── Bank specific vocabulary. Confirm every value against the real docs. ────

const BANK_DISPLAY_NAME = 'Guaranty Trust Bank';

/** Endpoints, relative to GTBANK_API_BASE_URL. CONFIRM ON RECEIPT OF DOCS. */
const ENDPOINTS = {
  mintVirtualAccount: '/collections/v1/virtual-accounts',
  releaseVirtualAccount: (providerReference) =>
    `/collections/v1/virtual-accounts/${encodeURIComponent(providerReference)}`,
  fetchSettlement: (providerReference) =>
    `/collections/v1/settlements/${encodeURIComponent(providerReference)}`,
  listSettlements: '/collections/v1/settlements',
  health: '/collections/v1/status',
};

/** Their settlement status vocabulary mapped onto ours. CONFIRM ON RECEIPT. */
const STATUS_MAP = Object.freeze({
  SUCCESS: 'successful',
  SUCCESSFUL: 'successful',
  COMPLETED: 'successful',
  '00': 'successful',
  PENDING: 'pending',
  IN_PROGRESS: 'pending',
  '09': 'pending',
  FAILED: 'failed',
  REVERSED: 'failed',
  DECLINED: 'failed',
});

/** Their channel vocabulary mapped onto ours (§5.2). CONFIRM ON RECEIPT. */
const CHANNEL_MAP = Object.freeze({
  NIP: 'transfer',
  TRANSFER: 'transfer',
  BANK_TRANSFER: 'transfer',
  USSD: 'ussd',
  CARD: 'card',
  WEB: 'card',
  POS: 'pos',
  AGENT: 'pos',
  BRANCH: 'bank_branch',
  COUNTER: 'bank_branch',
});

const SIGNATURE_HEADER = 'x-gtb-signature';
const TIMESTAMP_HEADER = 'x-gtb-timestamp';

/**
 * This adapter's own configuration, read and validated here rather than in the
 * shared config module. That is what keeps the promise in §5.1 literally true:
 * outside this file, nothing — not even the environment schema — knows GTBank
 * exists.
 */
const gtbankSchema = z.object({
  GTBANK_API_BASE_URL: z.string().url('GTBANK_API_BASE_URL must be a URL'),
  GTBANK_API_KEY: z.string().min(1, 'GTBANK_API_KEY is required'),
  GTBANK_MERCHANT_ID: z.string().min(1, 'GTBANK_MERCHANT_ID is required'),
  GTBANK_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

function loadGtbankConfig(env = process.env) {
  const parsed = gtbankSchema.safeParse(env);
  if (!parsed.success) {
    // Names only, never values.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`This bank adapter is not configured:\n${problems}`);
  }
  return parsed.data;
}

class GTBankAdapter extends BankCollectionAdapter {
  constructor({ fetchImpl, clock, env } = {}) {
    super();
    const settings = loadGtbankConfig(env);

    this.baseUrl = settings.GTBANK_API_BASE_URL.replace(/\/+$/, '');
    this.apiKey = settings.GTBANK_API_KEY;
    this.merchantId = settings.GTBANK_MERCHANT_ID;
    this.timeoutMs = settings.GTBANK_TIMEOUT_MS;
    // The webhook secret is shared infrastructure, not bank specific naming.
    this.webhookSecret = config.BANK_WEBHOOK_SECRET;
    this._fetch = fetchImpl || globalThis.fetch;
    this._clock = clock || (() => new Date());
  }

  get name() {
    return 'gtbank';
  }

  get displayName() {
    return BANK_DISPLAY_NAME;
  }

  // ─── BankCollectionAdapter ────────────────────────────────────────────────

  async mintVirtualAccount({ reference, amountKobo, payerName, expiresAt }) {
    const response = await this._request('POST', ENDPOINTS.mintVirtualAccount, {
      merchantId: this.merchantId,
      // Their "merchantReference" is our UNN Payment Reference. We mint it; the
      // bank only echoes it back on settlement.
      merchantReference: reference,
      amount: koboToDecimalString(amountKobo),
      currency: 'NGN',
      accountName: truncate(payerName, 60),
      expiryDateTime: toBankDateTime(expiresAt),
      isSingleUse: true,
    });

    const account = response.data || response;
    const accountNumber = account.accountNumber || account.virtualAccountNumber;
    const providerReference =
      account.reference || account.accountReference || account.transactionReference;

    if (!accountNumber || !providerReference) {
      throw new Error('Bank did not return an account number and reference');
    }

    return {
      accountNumber: String(accountNumber),
      bankName: BANK_DISPLAY_NAME,
      providerReference: String(providerReference),
      // Every channel resolves to the same virtual account and the same UNN
      // reference (§5.2), so attribution does not depend on how they paid.
      channels: ['transfer', 'ussd', 'card', 'pos', 'bank_branch'],
    };
  }

  verifySignature(rawBody, headers = {}) {
    const provided = header(headers, SIGNATURE_HEADER);
    const timestamp = header(headers, TIMESTAMP_HEADER);
    if (!provided || !timestamp) return false;

    // Replay window (§9.5).
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return false;
    const ageSeconds = Math.abs(Math.floor(this._clock().getTime() / 1000) - sent);
    if (ageSeconds > config.BANK_WEBHOOK_TOLERANCE_SECONDS) return false;

    // CONFIRM ON RECEIPT OF DOCS: signed message construction and digest.
    const expected = crypto
      .createHmac('sha512', this.webhookSecret)
      .update(`${timestamp}.${Buffer.from(rawBody).toString('utf8')}`, 'utf8')
      .digest('hex');

    return safeEqual(expected, provided);
  }

  parseWebhook(rawBody) {
    const payload = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    return this._translateSettlement(payload.data || payload);
  }

  async fetchSettlement(providerReference) {
    const response = await this._request(
      'GET',
      ENDPOINTS.fetchSettlement(providerReference),
      null,
      { allow404: true }
    );
    if (!response) return null;
    return this._translateSettlement(response.data || response);
  }

  async listSettlements({ from, to, cursor, limit = 200 }) {
    const query = new URLSearchParams({
      merchantId: this.merchantId,
      startDate: toBankDateTime(from),
      endDate: toBankDateTime(to),
      pageSize: String(limit),
    });
    if (cursor) query.set('pageToken', cursor);

    const response = await this._request(
      'GET',
      `${ENDPOINTS.listSettlements}?${query.toString()}`
    );
    const body = response.data || response;
    const rows = body.items || body.settlements || body.records || [];

    return {
      items: rows.map((row) => this._translateSettlement(row)),
      nextCursor: body.nextPageToken || body.nextCursor || undefined,
    };
  }

  async releaseVirtualAccount(providerReference) {
    await this._request('DELETE', ENDPOINTS.releaseVirtualAccount(providerReference), null, {
      allow404: true,
    });
    return { released: true };
  }

  async healthCheck() {
    await this._request('GET', ENDPOINTS.health);
    return { ok: true, detail: `${BANK_DISPLAY_NAME} reachable` };
  }

  // ─── Translation. The only place their vocabulary exists. ─────────────────

  _translateSettlement(row) {
    const rawStatus = String(row.status || row.transactionStatus || '').toUpperCase();
    const rawChannel = String(row.channel || row.paymentMethod || 'NIP').toUpperCase();

    const status = STATUS_MAP[rawStatus];
    if (!status) throw new Error(`Unmapped bank settlement status: ${rawStatus}`);

    return normaliseSettlement({
      providerReference: row.transactionReference || row.reference || row.sessionId,
      unnReference: row.merchantReference || row.customerReference || '',
      amountPaid: row.amountPaid || row.amount || row.transactionAmount,
      currency: (row.currency || 'NGN').toUpperCase(),
      channel: CHANNEL_MAP[rawChannel] || 'transfer',
      status,
      paidAt: fromBankDateTime(row.transactionDate || row.paymentDate || row.completedAt),
      payerAccountName: row.originatorAccountName || row.payerName || null,
      payerBank: row.originatorBankName || row.sourceBank || null,
      rawPayload: row,
    });
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  async _request(method, path, body, { allow404 = false } = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this._fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Merchant-Id': this.merchantId,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 404 && allow404) return null;

      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`Bank returned a non JSON response (HTTP ${response.status})`);
        }
      }

      if (!response.ok) {
        // Their error code never escapes this file; only a message does.
        const code = parsed && (parsed.responseCode || parsed.code || parsed.error);
        throw new Error(
          `Bank request failed (HTTP ${response.status}${code ? `, code ${code}` : ''})`
        );
      }

      return parsed;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeout = new Error(`Bank request timed out after ${this.timeoutMs}ms`);
        timeout.code = 'ETIMEDOUT';
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Their date format. CONFIRM ON RECEIPT OF DOCS. ─────────────────────────

/** Bank wire format: "YYYY-MM-DD HH:mm:ss" in UTC. */
function toBankDateTime(date) {
  const iso = new Date(date).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function fromBankDateTime(value) {
  if (!value) return new Date();
  if (value instanceof Date) return value;
  const text = String(value).trim();
  // Accept both their space separated form and plain ISO 8601.
  const normalised = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Unparseable bank date: ${value}`);
  return parsed;
}

function header(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function truncate(value, length) {
  const text = String(value || '');
  return text.length > length ? text.slice(0, length) : text;
}

module.exports = {
  GTBankAdapter,
  STATUS_MAP,
  CHANNEL_MAP,
  toBankDateTime,
  fromBankDateTime,
  loadGtbankConfig,
};
