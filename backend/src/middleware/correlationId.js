'use strict';

const crypto = require('crypto');
const { requestContext } = require('../config/logger');

const HEADER = 'x-correlation-id';

/**
 * Threads a correlation id through every request (§9.6). An id supplied by a
 * caller is honoured so a trace can span the mobile app and the API; otherwise
 * one is minted here. Everything logged during the request carries it, and so
 * does every audit entry and every Sentry event.
 */
module.exports = function correlationId(req, res, next) {
  const incoming = req.get(HEADER);
  const id =
    incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();

  req.correlationId = id;
  res.setHeader(HEADER, id);
  requestContext.run({ correlationId: id }, () => next());
};

module.exports.HEADER = HEADER;
