'use strict';

/**
 * Wraps an async route handler so a rejected promise reaches the error
 * middleware instead of hanging the request. Express 4 does not do this itself.
 */
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
