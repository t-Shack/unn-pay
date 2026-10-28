'use strict';

const { ValidationError } = require('../lib/errors');

/**
 * Validate a request against zod schemas before it reaches a controller (§11).
 * The parsed, typed result replaces the raw input, so a controller can never
 * accidentally read an unvalidated field.
 */
module.exports = function validate({ body, query, params }) {
  return (req, _res, next) => {
    try {
      if (params) req.params = params.parse(req.params);
      if (query) req.validatedQuery = query.parse(req.query);
      if (body) req.body = body.parse(req.body);
      next();
    } catch (error) {
      if (error && error.issues) {
        return next(
          new ValidationError(
            'Some of the details you sent are not valid',
            error.issues.map((issue) => ({
              field: issue.path.join('.') || '(body)',
              message: issue.message,
            }))
          )
        );
      }
      return next(error);
    }
  };
};
