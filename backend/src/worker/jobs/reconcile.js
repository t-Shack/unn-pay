'use strict';

const { Op } = require('sequelize');
const { Transaction: TransactionModel, WebhookEvent } = require('../../models');
const bankAdapters = require('../../adapters/bank');
const settlementService = require('../../services/settlementService');
const { logger } = require('../../config/logger');
const { captureException } = require('../../config/sentry');

/**
 * The reconciliation sweep (§9.2) — the safety net for every webhook that never
 * arrives, and the reason this system can claim resilience rather than just
 * assert it.
 *
 * Two passes, every ten minutes:
 *
 *   Pass 1 — targeted. For each Pending transaction older than five minutes, ask
 *            the bank directly whether that reference has been settled.
 *   Pass 2 — sweeping. List every settlement the bank reports in the last 24
 *            hours and apply any whose reference has no processed transaction.
 *            This catches money that arrived for a reference we would never have
 *            thought to ask about, including one whose mint response was lost.
 *
 * Both passes route through settlementService.applySettlement, which is
 * idempotent — necessary, because this job frequently races the very webhook it
 * is compensating for.
 */

const PENDING_GRACE_MINUTES = 5;
const LOOKBACK_HOURS = 24;

async function runReconciliation({
  now = new Date(),
  graceMinutes = PENDING_GRACE_MINUTES,
  lookbackHours = LOOKBACK_HOURS,
  maxTargeted = 500,
} = {}) {
  const stats = {
    targeted_checked: 0,
    targeted_settled: 0,
    swept_examined: 0,
    swept_applied: 0,
    errors: 0,
  };

  // --- Pass 1: ask about each stale pending transaction ---------------------
  const cutoff = new Date(now.getTime() - graceMinutes * 60 * 1000);
  const pending = await TransactionModel.findAll({
    where: {
      status: TransactionModel.STATUS.PENDING,
      created_at: { [Op.lt]: cutoff },
      expires_at: { [Op.gt]: new Date(now.getTime() - lookbackHours * 60 * 60 * 1000) },
    },
    order: [['created_at', 'ASC']],
    limit: maxTargeted,
  });

  for (const transaction of pending) {
    stats.targeted_checked += 1;
    try {
      const adapter = bankAdapters.getForTransaction(transaction);

      // Prefer a lookup by our own reference: a mint whose response was lost
      // leaves us with no provider reference at all, and that transaction is
      // exactly the one most likely to be stranded.
      let settlement = null;
      if (typeof adapter.fetchSettlementByReference === 'function') {
        settlement = await adapter.fetchSettlementByReference(transaction.unn_reference);
      }
      if (!settlement && transaction.virtual_account_reference) {
        settlement = await adapter.fetchSettlement(transaction.virtual_account_reference);
      }
      if (!settlement) continue;

      const result = await settlementService.applySettlement(settlement, {
        source: 'reconciliation',
        adapterName: adapter.name,
      });

      if (
        result.outcome === settlementService.OUTCOME.SETTLED ||
        result.outcome === settlementService.OUTCOME.UNAPPLIED_OPENED
      ) {
        stats.targeted_settled += 1;
        logger.info(
          {
            unn_reference: transaction.unn_reference,
            outcome: result.outcome,
          },
          'reconciliation recovered a settlement the webhook never delivered'
        );
      }
    } catch (error) {
      stats.errors += 1;
      logger.error(
        { unn_reference: transaction.unn_reference, err: error.message },
        'reconciliation failed for a transaction'
      );
      captureException(error, { unn_reference: transaction.unn_reference, phase: 'targeted' });
    }
  }

  // --- Pass 2: sweep everything the bank reports ----------------------------
  const from = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  try {
    const adapter = bankAdapters.getDefault();
    let cursor;

    do {
      const page = await adapter.listSettlements({ from, to: now, cursor });

      for (const settlement of page.items) {
        stats.swept_examined += 1;

        // Cheap pre-filter: if this settlement is already recorded against a
        // transaction, skip the work of opening a database transaction for it.
        const alreadyApplied = await TransactionModel.findOne({
          where: { provider_reference: settlement.providerReference },
          attributes: ['transaction_id'],
        });
        if (alreadyApplied) continue;

        try {
          const result = await settlementService.applySettlement(settlement, {
            source: 'reconciliation_sweep',
            adapterName: adapter.name,
          });
          if (
            result.outcome === settlementService.OUTCOME.SETTLED ||
            result.outcome === settlementService.OUTCOME.UNAPPLIED_OPENED
          ) {
            stats.swept_applied += 1;
            logger.warn(
              {
                provider_reference: settlement.providerReference,
                unn_reference: settlement.unnReference,
                outcome: result.outcome,
              },
              'sweep applied a settlement with no corresponding webhook'
            );
          }
        } catch (error) {
          stats.errors += 1;
          logger.error(
            { provider_reference: settlement.providerReference, err: error.message },
            'sweep failed to apply a settlement'
          );
          captureException(error, {
            provider_reference: settlement.providerReference,
            phase: 'sweep',
          });
        }
      }

      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    stats.errors += 1;
    logger.error({ err: error.message }, 'reconciliation sweep could not list settlements');
    captureException(error, { phase: 'sweep_list' });
  }

  logger.info(stats, 'reconciliation sweep complete');
  return stats;
}

/**
 * Retry webhook events whose processing failed. The body is already durable, so
 * this is a pure replay of work we owe, not a request to the bank.
 */
async function retryFailedWebhooks({ now = new Date(), limit = 100 } = {}) {
  const failed = await WebhookEvent.findAll({
    where: {
      processing_status: 'failed',
      received_at: { [Op.gt]: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    },
    order: [['received_at', 'ASC']],
    limit,
  });

  let recovered = 0;

  for (const event of failed) {
    try {
      const adapter = bankAdapters.getDefault();
      const settlement = adapter.parseWebhook(Buffer.from(event.raw_body, 'utf8'));
      const result = await settlementService.applySettlement(settlement, { source: 'webhook' });

      await event.update({
        processing_status:
          result.outcome === settlementService.OUTCOME.DUPLICATE_IGNORED
            ? 'ignored_duplicate'
            : 'processed',
        processed_at: new Date(),
        error_detail: null,
      });
      recovered += 1;
    } catch (error) {
      await event.update({ error_detail: String(error.message).slice(0, 1000) });
      logger.warn({ event_id: event.event_id, err: error.message }, 'webhook replay failed again');
    }
  }

  if (recovered > 0) logger.info({ recovered }, 'replayed previously failed webhooks');
  return { examined: failed.length, recovered };
}

module.exports = { runReconciliation, retryFailedWebhooks, PENDING_GRACE_MINUTES, LOOKBACK_HOURS };
