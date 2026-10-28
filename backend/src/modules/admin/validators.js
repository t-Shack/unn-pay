'use strict';

const { z } = require('zod');

const session = z.string().regex(/^\d{4}\/\d{4}$/, 'Session must look like 2025/2026');

/**
 * Money arriving from an admin is accepted as a string or an integer number of
 * naira, never as a fractional Number: JSON has only doubles, and 1500.10 does
 * not survive the round trip exactly. The money helpers reject anything unsafe.
 */
const amount = z.union([
  z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Amount must look like 150000 or 150000.50'),
  z.number().int().nonnegative(),
]);

const paginationQuery = {
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(25),
};

module.exports = {
  transactionsQuery: z.object({
    ...paginationQuery,
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    department: z.string().trim().max(100).optional(),
    level: z.string().trim().max(10).optional(),
    status: z.enum(['Pending', 'Successful', 'Failed', 'Expired', 'UnderReview']).optional(),
    fee_item_id: z.coerce.number().int().positive().optional(),
    matric_number: z.string().trim().max(20).optional(),
  }),

  exportQuery: z.object({
    format: z.enum(['csv', 'pdf']).default('csv'),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    department: z.string().trim().max(100).optional(),
    level: z.string().trim().max(10).optional(),
    status: z.enum(['Pending', 'Successful', 'Failed', 'Expired', 'UnderReview']).optional(),
    fee_item_id: z.coerce.number().int().positive().optional(),
    matric_number: z.string().trim().max(20).optional(),
  }),

  unappliedQuery: z.object({
    ...paginationQuery,
    status: z.enum(['open', 'resolved', 'expired', 'all']).default('open'),
  }),

  resolveUnapplied: z.object({
    resolution: z.enum([
      'applied_to_intended_fee',
      'applied_to_other_fee',
      'marked_for_refund',
      'dismissed',
    ]),
    // Every resolution requires a note (§10).
    note: z.string().trim().min(5, 'A resolution note of at least 5 characters is required').max(2000),
    target_fee_item_id: z.coerce.number().int().positive().optional(),
  }),

  idParam: z.object({ id: z.coerce.number().int().positive() }),

  feeItemsQuery: z.object({
    session: session.optional(),
    include_inactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  }),

  createFeeItem: z.object({
    name: z.string().trim().min(2).max(150),
    category: z.enum(['Tuition', 'Acceptance', 'Departmental', 'Hostel', 'Other']),
    amount,
    // null means "applies to every department" / "every level".
    department: z.string().trim().max(100).nullable().optional(),
    level: z.string().trim().max(10).nullable().optional(),
    session,
    is_active: z.boolean().optional(),
  }),

  updateFeeItem: z
    .object({
      name: z.string().trim().min(2).max(150).optional(),
      category: z.enum(['Tuition', 'Acceptance', 'Departmental', 'Hostel', 'Other']).optional(),
      amount: amount.optional(),
      department: z.string().trim().max(100).nullable().optional(),
      level: z.string().trim().max(10).nullable().optional(),
      session: session.optional(),
      is_active: z.boolean().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, 'Nothing to update'),

  importBody: z.object({ session }),

  commitImport: z.object({ allow_partial: z.boolean().optional().default(false) }),

  createStaff: z.object({
    staff_id: z.string().trim().min(2).max(50),
    full_name: z.string().trim().min(2).max(100),
    email: z.string().trim().email().max(100),
    password: z
      .string()
      .min(12, 'Staff passwords must be at least 12 characters')
      .max(128)
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/\d/, 'Must contain a number'),
    role: z.enum(['Bursary Staff', 'Super Admin']),
  }),

  summaryQuery: z.object({ session: session.optional() }),

  session,
  amount,
};
