'use strict';

const { NotFoundError } = require('../lib/errors');

module.exports = function notFound(req, _res, next) {
  next(new NotFoundError(`No route matches ${req.method} ${req.path}`, 'route_not_found'));
};
