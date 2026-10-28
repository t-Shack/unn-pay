'use strict';

const express = require('express');
const multer = require('multer');
const { DateTime } = require('luxon');

const service = require('./service');
const importService = require('./importService');
const exportService = require('./exportService');
const validators = require('./validators');
const authService = require('../auth/service');
const authValidators = require('../auth/validators');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../middleware/asyncHandler');
const idempotency = require('../../middleware/idempotency');
const { requireAdmin, requireSuperAdmin } = require('../../middleware/auth');
const { adminLoginLimiter } = require('../../middleware/rateLimit');
const { BadRequestError } = require('../../lib/errors');

/**
 * Bursary administration (§11.6). Every route below /login requires an
 * authenticated admin; staff creation additionally requires a Super Admin.
 */
const router = express.Router();

// CSV uploads are held in memory and never touched down on disk: Render's
// filesystem is ephemeral, and twelve factor forbids local state (§12).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/plain' ||
      file.originalname.toLowerCase().endsWith('.csv');
    cb(ok ? null : new BadRequestError('Upload a .csv file', 'not_a_csv'), ok);
  },
});

// --- authentication ---------------------------------------------------------

router.post(
  '/login',
  adminLoginLimiter,
  validate({ body: authValidators.adminLogin }),
  asyncHandler(async (req, res) => {
    const result = await authService.adminLogin({
      email: req.body.email,
      password: req.body.password,
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    });
    res.status(200).json(result);
  })
);

router.post(
  '/refresh',
  validate({ body: authValidators.refresh }),
  asyncHandler(async (req, res) => {
    const tokens = await authService.adminRefresh({
      refreshToken: req.body.refresh_token,
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    });
    res.status(200).json({ tokens });
  })
);

// Everything below requires an authenticated administrator.
router.use(requireAdmin);

router.get('/me', (req, res) => res.status(200).json({ admin: req.admin.toPublicJSON() }));

// --- dashboard --------------------------------------------------------------

router.get(
  '/dashboard/health',
  asyncHandler(async (_req, res) => res.status(200).json(await service.dashboardHealth()))
);

router.get(
  '/dashboard/summary',
  validate({ query: validators.summaryQuery }),
  asyncHandler(async (req, res) =>
    res.status(200).json(await service.summary({ session: req.validatedQuery.session }))
  )
);

// --- transactions -----------------------------------------------------------

const filtersFrom = (query) => ({
  from: query.from,
  to: query.to,
  department: query.department,
  level: query.level,
  status: query.status,
  feeItemId: query.fee_item_id,
  matricNumber: query.matric_number,
});

router.get(
  '/transactions',
  validate({ query: validators.transactionsQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listTransactions({
      ...filtersFrom(req.validatedQuery),
      page: req.validatedQuery.page,
      pageSize: req.validatedQuery.page_size,
    });
    res.status(200).json(result);
  })
);

router.get(
  '/transactions/export',
  validate({ query: validators.exportQuery }),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery;
    const items = await service.listTransactionsForExport(filtersFrom(query));
    const stamp = DateTime.now().setZone('Africa/Lagos').toFormat('yyyyLLdd-HHmm');

    if (query.format === 'pdf') {
      const pdf = await exportService.toPdf(items, {
        filters: {
          from: query.from ? query.from.toISOString().slice(0, 10) : undefined,
          to: query.to ? query.to.toISOString().slice(0, 10) : undefined,
          department: query.department,
          level: query.level,
          status: query.status,
        },
        generatedBy: req.admin.full_name,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="unn-pay-transactions-${stamp}.pdf"`);
      return res.status(200).send(pdf);
    }

    const csv = exportService.toCsv(items);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="unn-pay-transactions-${stamp}.csv"`);
    return res.status(200).send(csv);
  })
);

// --- unapplied payments -----------------------------------------------------

router.get(
  '/unapplied',
  validate({ query: validators.unappliedQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listUnapplied({
      status: req.validatedQuery.status,
      page: req.validatedQuery.page,
      pageSize: req.validatedQuery.page_size,
    });
    res.status(200).json(result);
  })
);

router.post(
  '/unapplied/:id/resolve',
  idempotency({ scope: 'admin:unapplied:resolve' }),
  validate({ params: validators.idParam, body: validators.resolveUnapplied }),
  asyncHandler(async (req, res) => {
    const result = await service.resolveUnapplied({
      unappliedId: req.params.id,
      adminId: req.admin.admin_id,
      resolution: req.body.resolution,
      note: req.body.note,
      targetFeeItemId: req.body.target_fee_item_id,
      ipAddress: req.ip,
    });
    res.status(200).json({
      unapplied: service.serialiseUnapplied(result.unapplied),
      receipt_number: result.receipt ? result.receipt.receipt_number : null,
    });
  })
);

// --- fee items --------------------------------------------------------------

router.get(
  '/fee-items',
  validate({ query: validators.feeItemsQuery }),
  asyncHandler(async (req, res) => {
    const items = await service.listFeeItems({
      session: req.validatedQuery.session,
      includeInactive: req.validatedQuery.include_inactive,
    });
    res.status(200).json({ items });
  })
);

router.post(
  '/fee-items',
  validate({ body: validators.createFeeItem }),
  asyncHandler(async (req, res) => {
    const feeItem = await service.createFeeItem({
      data: req.body,
      adminId: req.admin.admin_id,
      ipAddress: req.ip,
    });
    res.status(201).json({ fee_item: feeItem });
  })
);

router.put(
  '/fee-items/:id',
  validate({ params: validators.idParam, body: validators.updateFeeItem }),
  asyncHandler(async (req, res) => {
    const feeItem = await service.updateFeeItem({
      feeItemId: req.params.id,
      data: req.body,
      adminId: req.admin.admin_id,
      ipAddress: req.ip,
    });
    res.status(200).json({ fee_item: feeItem });
  })
);

// Soft delete only (§11.6). A fee with payments against it is never removed.
router.delete(
  '/fee-items/:id',
  validate({ params: validators.idParam }),
  asyncHandler(async (req, res) => {
    const feeItem = await service.deactivateFeeItem({
      feeItemId: req.params.id,
      adminId: req.admin.admin_id,
      ipAddress: req.ip,
    });
    res.status(200).json({ fee_item: feeItem, message: 'Fee item deactivated' });
  })
);

// --- student import ---------------------------------------------------------

router.post(
  '/students/import',
  upload.single('file'),
  validate({ body: validators.importBody }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new BadRequestError('Attach a CSV file as "file"', 'file_required');

    const result = await importService.previewImport({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      session: req.body.session,
      adminId: req.admin.admin_id,
      ipAddress: req.ip,
    });

    // 200, not 201: nothing has been created yet. The admin must confirm.
    res.status(200).json(result);
  })
);

router.post(
  '/students/imports/:id/commit',
  validate({ params: validators.idParam, body: validators.commitImport }),
  asyncHandler(async (req, res) => {
    const result = await importService.commitImport({
      importId: req.params.id,
      adminId: req.admin.admin_id,
      ipAddress: req.ip,
      allowPartial: req.body.allow_partial,
    });
    res.status(200).json(result);
  })
);

router.get(
  '/students/imports',
  asyncHandler(async (_req, res) => res.status(200).json(await importService.listImports()))
);

router.get(
  '/students/imports/:id',
  validate({ params: validators.idParam }),
  asyncHandler(async (req, res) => res.status(200).json(await importService.getImport(req.params.id)))
);

// --- staff (Super Admin only) -----------------------------------------------

router.post(
  '/staff',
  requireSuperAdmin,
  validate({ body: validators.createStaff }),
  asyncHandler(async (req, res) => {
    const admin = await service.createStaff({
      data: req.body,
      adminId: req.admin.admin_id,
      ipAddress: req.ip,
    });
    res.status(201).json({ admin });
  })
);

module.exports = router;
