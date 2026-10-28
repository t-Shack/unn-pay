'use strict';

const express = require('express');
const { z } = require('zod');
const bankAdapters = require('../../adapters/bank');
const webhookService = require('../webhooks/service');
const asyncHandler = require('../../middleware/asyncHandler');
const validate = require('../../middleware/validate');
const { BadRequestError } = require('../../lib/errors');
const config = require('../../config');

/**
 * Sandbox simulation routes — development and demos only.
 *
 * These stand in for the bank pushing money at us, so the whole lifecycle can be
 * driven end to end with no bank credentials: mint, pay, underpay, overpay, pay
 * twice, pay a reference that was never minted, or arrange for a payment that
 * arrives with no webhook at all so the reconciliation sweep has to find it.
 *
 * app.js only mounts this router when NODE_ENV is not production AND
 * BANK_ADAPTER is sandbox. A route that invents settlements must not exist in a
 * deployment that handles real money, so the guard is doubled here as well.
 */
const router = express.Router();

router.use((_req, _res, next) => {
  if (config.isProduction || config.BANK_ADAPTER !== 'sandbox') {
    return next(new BadRequestError('Sandbox routes are not available', 'sandbox_disabled'));
  }
  return next();
});

const paySchema = z.object({
  unn_reference: z.string().trim().min(6).max(24).transform((v) => v.toUpperCase()),
  // Naira, as a string, so no float ever enters. Omit to pay the exact expected amount.
  amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).optional(),
  scenario: z.enum(['exact', 'underpayment', 'overpayment']).default('exact'),
  channel: z.enum(['transfer', 'ussd', 'card', 'pos', 'bank_branch']).default('transfer'),
  status: z.enum(['successful', 'failed', 'pending']).default('successful'),
  // false leaves the settlement sitting at the "bank" with no webhook delivered,
  // so the reconciliation sweep is the only thing that can find it (§9.2).
  deliver_webhook: z.boolean().default(true),
  // Deliver the same signed webhook more than once, to prove idempotency (§9.1).
  deliveries: z.number().int().min(1).max(5).default(1),
});

router.post(
  '/pay',
  validate({ body: paySchema }),
  asyncHandler(async (req, res) => {
    const adapter = bankAdapters.get('sandbox');
    const sandbox = adapter.inner || adapter;

    const { toKobo } = require('../../lib/money');

    const { settlement, webhook } = await sandbox.simulatePayment({
      unnReference: req.body.unn_reference,
      amountKobo: req.body.amount !== undefined ? toKobo(req.body.amount) : undefined,
      scenario: req.body.scenario,
      channel: req.body.channel,
      status: req.body.status,
    });

    const deliveries = [];
    if (req.body.deliver_webhook) {
      for (let i = 0; i < req.body.deliveries; i += 1) {
        // Delivered through the real webhook path, signature and all, so this
        // exercises exactly what the bank would exercise.
        const result = await webhookService.handleInboundWebhook({
          rawBody: Buffer.from(webhook.body, 'utf8'),
          headers: webhook.headers,
          adapterName: 'sandbox',
          ipAddress: req.ip,
        });
        deliveries.push({ attempt: i + 1, ...result });
      }
    }

    res.status(200).json({
      simulated: {
        provider_reference: settlement.providerReference,
        unn_reference: settlement.unnReference,
        amount_paid_kobo: settlement.amountPaidKobo,
        channel: settlement.channel,
        status: settlement.status,
        paid_at: settlement.paidAt,
      },
      webhook_delivered: req.body.deliver_webhook,
      deliveries,
      note: req.body.deliver_webhook
        ? undefined
        : 'No webhook was delivered. The reconciliation sweep should find this settlement.',
    });
  })
);

/** Inspect what the simulated bank currently holds. */
router.get(
  '/settlements',
  asyncHandler(async (_req, res) => {
    const adapter = bankAdapters.get('sandbox');
    const sandbox = adapter.inner || adapter;
    const result = await sandbox.listSettlements({
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      to: new Date(),
    });
    res.status(200).json({
      items: result.items.map((item) => ({
        provider_reference: item.providerReference,
        unn_reference: item.unnReference,
        amount_paid_kobo: item.amountPaidKobo,
        status: item.status,
        channel: item.channel,
        paid_at: item.paidAt,
      })),
    });
  })
);

/** Force the bank adapter to fail, so the circuit breaker can be demonstrated. */
router.post(
  '/inject-fault',
  validate({
    body: z.object({
      method: z.enum(['mintVirtualAccount', 'fetchSettlement', 'listSettlements']),
      mode: z.enum(['error', 'timeout', 'malformed']).default('error'),
      times: z.number().int().min(1).max(20).default(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const adapter = bankAdapters.get('sandbox');
    const sandbox = adapter.inner || adapter;
    sandbox.injectFault(req.body.method, req.body.mode, { times: req.body.times });
    res.status(200).json({
      injected: req.body,
      circuit: adapter.circuitSnapshot ? adapter.circuitSnapshot() : null,
    });
  })
);

router.post(
  '/clear-faults',
  asyncHandler(async (_req, res) => {
    const adapter = bankAdapters.get('sandbox');
    const sandbox = adapter.inner || adapter;
    sandbox.clearFaults();
    if (adapter.breaker) adapter.breaker.reset();
    res.status(200).json({ cleared: true, circuit: adapter.circuitSnapshot() });
  })
);

module.exports = router;
