'use strict';

const express = require('express');
const { sequelize } = require('../../models');
const bankAdapters = require('../../adapters/bank');
const asyncHandler = require('../../middleware/asyncHandler');
const config = require('../../config');

/**
 * Liveness and readiness (§9.6).
 *
 * /health is a liveness probe: it answers if the process is running at all, and
 * touches nothing, so a database blip never causes an orchestrator to restart a
 * perfectly healthy API.
 *
 * /health/ready is a readiness probe: it checks the database and the bank
 * adapter, and reports 503 when either is unusable, so a struggling instance is
 * taken out of rotation rather than being sent traffic it cannot serve.
 */
const router = express.Router();

const startedAt = Date.now();

router.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: process.env.SERVICE_NAME || 'unn-pay-api',
    version: require('../../../package.json').version,
    environment: config.NODE_ENV,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
  });
});

router.get(
  '/health/ready',
  asyncHandler(async (_req, res) => {
    const checks = {};

    try {
      const start = Date.now();
      await sequelize.query('SELECT 1');
      checks.database = { ok: true, latency_ms: Date.now() - start };
    } catch (error) {
      checks.database = { ok: false, detail: error.message };
    }

    try {
      const adapter = bankAdapters.getDefault();
      const result = await adapter.healthCheck();
      checks.bank_adapter = { adapter: adapter.name, ...result };
    } catch (error) {
      checks.bank_adapter = { ok: false, detail: error.message };
    }

    const ready = Object.values(checks).every((check) => check.ok);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  })
);

module.exports = router;
