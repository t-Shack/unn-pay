'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const config = require('./config');
const { logger } = require('./config/logger');
const correlationId = require('./middleware/correlationId');
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');
const { apiLimiter } = require('./middleware/rateLimit');

/**
 * The Express application.
 *
 * Exported without being started, so the test suite can drive it with supertest
 * and the server entry point can own process concerns like signal handling.
 */
function createApp() {
  const app = express();

  // Render (and any reverse proxy) terminates TLS upstream. Without this, req.ip
  // is the proxy's address and every per IP rate limit collapses into one bucket.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(correlationId);

  app.use(
    helmet({
      // HSTS (§13.1). Only meaningful over HTTPS, so it is not set locally.
      hsts: config.isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The verification page ships its styles inline, by design: it must
          // render from a single response on a poor connection.
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  // Strict CORS allowlist (§13.7): the admin SPA origin and the app's custom
  // schemes, and nothing else. Native mobile requests carry no Origin header.
  const allowedOrigins = new Set(config.ADMIN_ORIGINS);
  const allowedSchemes = config.APP_SCHEMES.map((scheme) => `${scheme}://`);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        if (allowedSchemes.some((scheme) => origin.startsWith(scheme))) return callback(null, true);
        logger.warn({ origin }, 'CORS origin rejected');
        return callback(new Error('Origin not permitted by CORS policy'));
      },
      credentials: false,
      exposedHeaders: ['x-correlation-id', 'Idempotent-Replay', 'RateLimit-Remaining'],
      maxAge: 600,
    })
  );

  app.use(compression());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.correlationId,
      autoLogging: {
        // Health checks would otherwise dominate the log volume.
        ignore: (req) => req.url === '/health' || req.url === '/api/v1/health',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );

  // The webhook is mounted BEFORE the JSON parser and uses a raw body parser of
  // its own (§11.4). Parsing and re-serialising would break signature checks.
  app.use('/api/v1/webhooks', require('./modules/webhooks/routes'));

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // Health checks sit outside the rate limiter and outside /api/v1 as well, so
  // an orchestrator can reach them at either path.
  app.use('/', require('./modules/health/routes'));
  app.use('/api/v1', require('./modules/health/routes'));

  // Public receipt verification: unauthenticated, and carries its own limiter.
  app.use('/', require('./modules/public/routes'));
  app.use('/api/v1', require('./modules/public/routes'));

  const api = express.Router();
  api.use(apiLimiter);
  api.use('/auth', require('./modules/auth/routes'));
  api.use('/fees', require('./modules/fees/routes'));
  api.use('/payments', require('./modules/payments/routes'));
  api.use('/notifications', require('./modules/notifications/routes'));
  api.use('/admin', require('./modules/admin/routes'));

  // The sandbox simulator is a development and demo affordance and must never
  // exist in production, where a route that invents settlements would be a
  // catastrophic hole.
  if (!config.isProduction && config.BANK_ADAPTER === 'sandbox') {
    api.use('/sandbox', require('./modules/sandbox/routes'));
    logger.warn('sandbox simulation routes are mounted (non production only)');
  }

  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
