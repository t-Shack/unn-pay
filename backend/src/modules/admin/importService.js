'use strict';

const { parse } = require('csv-parse/sync');
const { Op } = require('sequelize');
const { Student, StudentImport, sequelize } = require('../../models');
const audit = require('../../services/auditService');
const { BadRequestError, NotFoundError, ConflictError } = require('../../lib/errors');
const { logger } = require('../../config/logger');

/**
 * Bursary student import (§11.6).
 *
 * Transactional and previewable, because a half imported student list during
 * registration week is a disaster: every row is validated first, every failure
 * is reported with its row number, and nothing is written to `students` until an
 * admin looks at the report and confirms it.
 *
 * The flow is two calls:
 *   POST /admin/students/import          -> validates, stores a preview, writes nothing
 *   POST /admin/students/imports/:id/commit -> writes every valid row in one transaction
 */

const REQUIRED_COLUMNS = ['matric_number', 'full_name', 'email', 'department', 'level'];
const OPTIONAL_COLUMNS = ['phone'];
const MATRIC_PATTERN = /^\d{4}\/\d{6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ROWS = 20000;

/** Accept the obvious header spellings a spreadsheet will produce. */
const HEADER_ALIASES = {
  'matric number': 'matric_number',
  matricnumber: 'matric_number',
  matric: 'matric_number',
  'registration number': 'matric_number',
  'full name': 'full_name',
  fullname: 'full_name',
  name: 'full_name',
  'email address': 'email',
  'e-mail': 'email',
  'phone number': 'phone',
  mobile: 'phone',
  faculty: 'department',
  dept: 'department',
  'level of study': 'level',
};

const normaliseHeader = (header) => {
  const cleaned = String(header || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return HEADER_ALIASES[cleaned] || cleaned.replace(/ /g, '_');
};

/**
 * Parse and validate a CSV buffer. Writes nothing.
 * @returns {{valid: Array, errors: Array, rowCount: number}}
 */
function validateCsv(buffer, { session }) {
  let records;
  try {
    records = parse(buffer, {
      columns: (header) => header.map(normaliseHeader),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });
  } catch (error) {
    throw new BadRequestError(
      `That file could not be read as CSV: ${error.message}`,
      'csv_unparseable'
    );
  }

  if (records.length === 0) {
    throw new BadRequestError('That file contains no rows', 'csv_empty');
  }
  if (records.length > MAX_ROWS) {
    throw new BadRequestError(
      `That file has ${records.length} rows; the maximum is ${MAX_ROWS}. Split it and import in parts.`,
      'csv_too_large'
    );
  }

  const present = new Set(Object.keys(records[0]));
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new BadRequestError(
      `The file is missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ` +
        `Expected: ${[...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(', ')}.`,
      'csv_missing_columns',
      { missing }
    );
  }

  const valid = [];
  const errors = [];
  const seenMatric = new Map();
  const seenEmail = new Map();

  records.forEach((record, index) => {
    // Row 1 is the header, so the first data row is row 2 in the admin's file.
    const rowNumber = index + 2;
    const rowErrors = [];

    const matric = String(record.matric_number || '').trim();
    const fullName = String(record.full_name || '').trim();
    const email = String(record.email || '').trim().toLowerCase();
    const department = String(record.department || '').trim();
    const level = String(record.level || '').trim();
    const phone = String(record.phone || '').trim() || null;

    if (!matric) rowErrors.push('matric_number is missing');
    else if (!MATRIC_PATTERN.test(matric)) {
      rowErrors.push(`matric_number "${matric}" is not in the format 2022/248400`);
    }

    if (!fullName) rowErrors.push('full_name is missing');
    else if (fullName.length > 100) rowErrors.push('full_name is longer than 100 characters');

    if (!email) rowErrors.push('email is missing');
    else if (!EMAIL_PATTERN.test(email)) rowErrors.push(`email "${email}" is not a valid address`);
    else if (email.length > 100) rowErrors.push('email is longer than 100 characters');

    if (!department) rowErrors.push('department is missing');
    if (!level) rowErrors.push('level is missing');
    else if (level.length > 10) rowErrors.push('level is longer than 10 characters');

    // Duplicates inside the file itself, which a database constraint would only
    // catch one at a time.
    if (matric && seenMatric.has(matric)) {
      rowErrors.push(`matric_number "${matric}" also appears on row ${seenMatric.get(matric)}`);
    }
    if (email && seenEmail.has(email)) {
      rowErrors.push(`email "${email}" also appears on row ${seenEmail.get(email)}`);
    }

    if (rowErrors.length > 0) {
      errors.push({ row: rowNumber, matric_number: matric || null, errors: rowErrors });
      return;
    }

    seenMatric.set(matric, rowNumber);
    seenEmail.set(email, rowNumber);

    valid.push({
      row: rowNumber,
      matric_number: matric,
      full_name: fullName,
      email,
      department,
      level,
      phone,
      session,
    });
  });

  return { valid, errors, rowCount: records.length };
}

/**
 * Step 1: validate and store a preview. Writes to student_imports only; not one
 * row reaches `students`.
 */
async function previewImport({ buffer, filename, session, adminId, ipAddress }) {
  const { valid, errors, rowCount } = validateCsv(buffer, { session });

  // Clashes with students already in the database. Existing rows are an update,
  // not an error, so they are reported separately from failures.
  const existing = await Student.findAll({
    where: {
      [Op.or]: [
        { matric_number: { [Op.in]: valid.map((r) => r.matric_number) } },
        { email: { [Op.in]: valid.map((r) => r.email) } },
      ],
    },
    attributes: ['student_id', 'matric_number', 'email', 'status'],
  });

  const existingByMatric = new Map(existing.map((s) => [s.matric_number, s]));
  const existingByEmail = new Map(existing.map((s) => [s.email, s]));

  const conflicts = [];
  const toCreate = [];
  const toUpdate = [];

  for (const row of valid) {
    const byMatric = existingByMatric.get(row.matric_number);
    const byEmail = existingByEmail.get(row.email);

    if (byMatric && byEmail && byMatric.student_id !== byEmail.student_id) {
      conflicts.push({
        row: row.row,
        matric_number: row.matric_number,
        errors: [
          `matric_number belongs to student ${byMatric.student_id} but email belongs to student ${byEmail.student_id}`,
        ],
      });
      continue;
    }
    if (!byMatric && byEmail) {
      conflicts.push({
        row: row.row,
        matric_number: row.matric_number,
        errors: [`email "${row.email}" is already used by matric number ${byEmail.matric_number}`],
      });
      continue;
    }
    if (byMatric) {
      // An already active student is never overwritten by an import: their
      // password and status are theirs, not the spreadsheet's.
      toUpdate.push({ ...row, student_id: byMatric.student_id, current_status: byMatric.status });
    } else {
      toCreate.push(row);
    }
  }

  const allErrors = [...errors, ...conflicts].sort((a, b) => a.row - b.row);

  const record = await StudentImport.create({
    admin_id: adminId,
    filename,
    session,
    row_count: rowCount,
    success_count: toCreate.length + toUpdate.length,
    failure_count: allErrors.length,
    status: 'previewed',
    error_report: {
      errors: allErrors,
      to_create: toCreate,
      to_update: toUpdate.map(({ current_status, ...rest }) => ({ ...rest, current_status })),
    },
  });

  logger.info(
    { import_id: record.import_id, rows: rowCount, ok: toCreate.length + toUpdate.length, failed: allErrors.length },
    'student import previewed'
  );

  return {
    import_id: record.import_id,
    filename,
    session,
    row_count: rowCount,
    will_create: toCreate.length,
    will_update: toUpdate.length,
    failure_count: allErrors.length,
    errors: allErrors,
    sample: toCreate.slice(0, 10),
    status: 'previewed',
    // Nothing has been written. The admin must confirm.
    committed: false,
  };
}

/**
 * Step 2: commit a previewed import. One database transaction: either every
 * valid row lands or none does.
 */
async function commitImport({ importId, adminId, ipAddress, allowPartial = false }) {
  const record = await StudentImport.findByPk(importId);
  if (!record) throw new NotFoundError('Import not found', 'import_not_found');
  if (record.status === 'committed') {
    throw new ConflictError('This import has already been committed', 'import_already_committed');
  }
  if (record.status === 'rejected') {
    throw new ConflictError('This import was rejected', 'import_rejected');
  }

  const report = record.error_report || {};
  const toCreate = report.to_create || [];
  const toUpdate = report.to_update || [];

  if (!allowPartial && (report.errors || []).length > 0) {
    throw new BadRequestError(
      `This file has ${report.errors.length} invalid row${report.errors.length === 1 ? '' : 's'}. ` +
        'Fix them and upload again, or confirm with allow_partial to import only the valid rows.',
      'import_has_errors',
      { failure_count: report.errors.length }
    );
  }

  const result = await sequelize.transaction(async (t) => {
    let created = 0;
    let updated = 0;

    if (toCreate.length > 0) {
      await Student.bulkCreate(
        toCreate.map((row) => ({
          matric_number: row.matric_number,
          full_name: row.full_name,
          email: row.email,
          phone: row.phone,
          department: row.department,
          level: row.level,
          status: 'imported',
        })),
        { transaction: t, validate: true }
      );
      created = toCreate.length;
    }

    for (const row of toUpdate) {
      // Never touch password_hash or status here: an active student stays active
      // and keeps their credentials.
      const [count] = await Student.update(
        {
          full_name: row.full_name,
          email: row.email,
          phone: row.phone,
          department: row.department,
          level: row.level,
        },
        { where: { student_id: row.student_id }, transaction: t }
      );
      updated += count;
    }

    await record.update(
      {
        status: 'committed',
        success_count: created + updated,
      },
      { transaction: t }
    );

    await audit.record({
      actorType: audit.ACTOR.ADMIN,
      actorId: adminId,
      action: audit.ACTION.STUDENTS_IMPORTED,
      entityType: 'student_import',
      entityId: record.import_id,
      after: {
        filename: record.filename,
        session: record.session,
        created,
        updated,
        failed: (report.errors || []).length,
      },
      ipAddress,
      transaction: t,
    });

    return { created, updated };
  });

  logger.info({ import_id: importId, ...result }, 'student import committed');

  return {
    import_id: record.import_id,
    status: 'committed',
    committed: true,
    created: result.created,
    updated: result.updated,
    failure_count: (report.errors || []).length,
  };
}

async function getImport(importId) {
  const record = await StudentImport.findByPk(importId);
  if (!record) throw new NotFoundError('Import not found', 'import_not_found');

  const report = record.error_report || {};
  return {
    import_id: record.import_id,
    filename: record.filename,
    session: record.session,
    status: record.status,
    row_count: record.row_count,
    success_count: record.success_count,
    failure_count: record.failure_count,
    errors: report.errors || [],
    will_create: (report.to_create || []).length,
    will_update: (report.to_update || []).length,
    created_at: record.created_at,
  };
}

async function listImports({ page = 1, pageSize = 25 } = {}) {
  const { rows, count } = await StudentImport.findAndCountAll({
    order: [['created_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return {
    items: rows.map((row) => ({
      import_id: row.import_id,
      filename: row.filename,
      session: row.session,
      status: row.status,
      row_count: row.row_count,
      success_count: row.success_count,
      failure_count: row.failure_count,
      created_at: row.created_at,
    })),
    pagination: { page, page_size: pageSize, total: count, total_pages: Math.max(1, Math.ceil(count / pageSize)) },
  };
}

module.exports = {
  validateCsv,
  previewImport,
  commitImport,
  getImport,
  listImports,
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
  MAX_ROWS,
};
