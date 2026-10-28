'use strict';

const { UniqueConstraintError } = require('sequelize');
const { WebhookEvent } = require('../../models');
const bankAdapters = require('../../adapters/bank');
const settlementService = require('../../services/settlementService');
const audit = require('../../services/auditService');
const { sha256 } = require('../../lib/hmac');
const { logger } = require('../../config/logger');

/**
 * Inbound bank webhooks (§9.5, §11.4).
 *
 * The order of operations here is the whole point and is not negotiable:
 *
 *   1. verify the signature — before any database write
 *   2. persist the raw body verbatim — before any parse attempt
 *   3. parse, and process idempotently
 *   4. return 200 once persisted, even if step 3 failed
 *
 * Step 4 matters as much as step 1. Returning a 500 invites the bank to hammer
 * us with retries during exactly the incident that caused the failure; the
 * evidence is already durable, so the reconciliation sweep will finish the job.
 */

const OUTCOME = Object.freeze({
  PROCESSED: 'processed',
  DUPLICATE: 'ignored_duplicate',
  FAILED: 'failed',
  REJECTED: 'rejected',
});

/**
 * @param {{rawBody: Buffer, headers: object, adapterName?: string, ipAddress?: string}} params
 */
async function handleInboundWebhook({ rawBody, headers, adapterName, ipAddress }) {
  const adapter = bankAdapters.get(adapterName);
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
  const payloadHash = sha256(body);

  // --- 1. signature, before anything is written -----------------------------
  const signatureValid = adapter.verifySignature(body, normaliseHeaders(headers));

  if (!signatureValid) {
    // Rejected outright. The body is not stored: an unauthenticated caller must
    // not be able to write rows into our tables by posting junk at this URL.
    logger.warn({ ip: ipAddress, bytes: body.length }, 'webhook rejected: invalid signature');
    await audit.recordSystem({
      action: audit.ACTION.WEBHOOK_REJECTED,
      entityType: 'webhook',
      entityId: null,
      after: { reason: 'invalid_signature', payload_hash: payloadHash, bytes: body.length },
      ipAddress,
    });
    return { status: 401, outcome: OUTCOME.REJECTED, reason: 'invalid_signature' };
  }

  // --- 2. persist the raw body before parsing -------------------------------
  // If the parse throws, the evidence survives.
  let parsed = null;
  let parseError = null;
  try {
    parsed = adapter.parseWebhook(body);
  } catch (error) {
    parseError = error;
  }

  let event;
  try {
    event = await WebhookEvent.create({
      provider_reference: parsed ? parsed.providerReference : null,
      unn_reference: parsed ? parsed.unnReference : null,
      raw_payload: safeJson(body),
      raw_body: body.toString('utf8').slice(0, 100000),
      payload_hash: payloadHash,
      signature_valid: true,
      processing_status: parseError ? 'failed' : 'received',
      error_detail: parseError ? String(parseError.message).slice(0, 1000) : null,
      received_at: new Date(),
    });
  } catch (error) {
    // The unique index on (provider_reference, payload_hash) makes replay
    // detection trivial: the identical event has already been recorded.
    if (error instanceof UniqueConstraintError) {
      logger.info(
        { provider_reference: parsed && parsed.providerReference },
        'duplicate webhook delivery ignored'
      );
      return { status: 200, outcome: OUTCOME.DUPLICATE, reason: 'already_received' };
    }
    throw error;
  }

  if (parseError) {
    logger.error({ event_id: event.event_id, err: parseError.message }, 'webhook body unparseable');
    // Still a 200: the body is stored, and a retry of the same malformed body
    // will not help either of us.
    return { status: 200, outcome: OUTCOME.FAILED, reason: 'unparseable', eventId: event.event_id };
  }

  // --- 3. process ------------------------------------------------------------
  try {
    const result = await settlementService.applySettlement(parsed, {
      source: 'webhook',
      adapterName: adapter.name,
    });

    await event.update({
      processing_status:
        result.outcome === settlementService.OUTCOME.DUPLICATE_IGNORED
          ? 'ignored_duplicate'
          : 'processed',
      processed_at: new Date(),
    });

    return {
      status: 200,
      outcome: OUTCOME.PROCESSED,
      settlementOutcome: result.outcome,
      eventId: event.event_id,
    };
  } catch (error) {
    // --- 4. a processing failure is ours to fix, not the bank's to retry -----
    logger.error(
      { event_id: event.event_id, err: error.message, stack: error.stack },
      'webhook processing failed; the reconciliation sweep will retry'
    );
    await event.update({
      processing_status: 'failed',
      error_detail: String(error.message).slice(0, 1000),
      processed_at: new Date(),
    });
    return { status: 200, outcome: OUTCOME.FAILED, reason: 'processing_error', eventId: event.event_id };
  }
}

/** Header names arrive with inconsistent casing; normalise once. */
function normaliseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** JSONB wants an object; a body that is not JSON is stored as a wrapper. */
function safeJson(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
  } catch {
    return null;
  }
}

module.exports = { handleInboundWebhook, OUTCOME };
