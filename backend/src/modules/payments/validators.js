'use strict';

const { z } = require('zod');

/**
 * The client sends a fee item id and nothing else (§11.3). There is deliberately
 * no amount field anywhere in this schema: an amount arriving from a client is
 * never trusted, so it is never even accepted. `.strict()` means a client that
 * tries to send one gets a validation error rather than having it ignored.
 */
module.exports = {
  initiate: z
    .object({ fee_item_id: z.coerce.number().int().positive() })
    .strict('Only fee_item_id may be sent; the amount is resolved by the server'),

  referenceParam: z.object({
    reference: z
      .string()
      .trim()
      .max(24)
      .transform((value) => value.toUpperCase()),
  }),

  historyQuery: z.object({
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(20),
    status: z.enum(['Pending', 'Successful', 'Failed', 'Expired', 'UnderReview']).optional(),
  }),
};
