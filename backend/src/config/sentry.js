'use strict';

const config = require('./index');
const { getCorrelationId, logger } = require('./logger');

/**
 * Error tracking (§9.6). Wired into both the API and the worker, with the
 * correlation id attached to every captured event so a Sentry issue can be
 * traced straight back to the log lines that produced it.
 *
 * Sentry is optional: with no SENTRY_DSN the whole module degrades to no-ops,
 * so local development and the test suite never talk to it.
 */

let Sentry = null;
let enabled = false;

function init({ serviceName = process.env.SERVICE_NAME || 'unn-pay-api' } = {}) {
  if (enabled || !config.SENTRY_DSN) return null;

  // eslint-disable-next-line global-require
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    serverName: serviceName,
    // Nothing sensitive should reach Sentry either.
    beforeSend(event) {
      if (event.request && event.request.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
        delete event.request.headers['x-bank-signature'];
      }
      if (event.request && event.request.data) delete event.request.data;
      return event;
    },
  });
  enabled = true;
  logger.info({ service: serviceName }, 'sentry initialised');
  return Sentry;
}

function captureException(error, context = {}) {
  if (!enabled || !Sentry) return;
  Sentry.withScope((scope) => {
    const correlationId = context.correlationId || getCorrelationId();
    if (correlationId) scope.setTag('correlation_id', correlationId);
    for (const [key, value] of Object.entries(context)) {
      if (key !== 'correlationId' && value !== undefined) scope.setExtra(key, value);
    }
    Sentry.captureException(error);
  });
}

function captureMessage(message, context = {}) {
  if (!enabled || !Sentry) return;
  Sentry.withScope((scope) => {
    const correlationId = context.correlationId || getCorrelationId();
    if (correlationId) scope.setTag('correlation_id', correlationId);
    Sentry.captureMessage(message);
  });
}

const flush = async (timeout = 2000) => (enabled && Sentry ? Sentry.flush(timeout) : true);

module.exports = { init, captureException, captureMessage, flush, isEnabled: () => enabled };
