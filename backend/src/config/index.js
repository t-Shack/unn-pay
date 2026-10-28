'use strict';

/**
 * Centralised, validated configuration. Every value the application needs comes
 * from the environment (twelve factor, per §12) and is validated once at boot so
 * a misconfigured deployment fails immediately and loudly rather than at the
 * first payment.
 */

const { z } = require('zod');

// Load a .env file when one is present. Production supplies real environment
// variables and has no .env, so a missing file is never an error.
require('./loadEnv')();

const bool = (defaultValue) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: bool(undefined),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    RECEIPT_SIGNING_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // Validated against the adapter registry at selection time, not here, so
    // adding a bank never means editing this file.
    BANK_ADAPTER: z.string().min(1).default('sandbox'),
    BANK_WEBHOOK_SECRET: z.string().min(16),
    BANK_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

    // A bank specific adapter's own configuration is NOT declared here. Each
    // adapter reads and validates its own namespaced variables, so this file —
    // and therefore every other file that imports it — stays free of any
    // knowledge of which bank is in use (§5.1).

    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('UNN Pay <no-reply@unn.edu.ng>'),
    BURSARY_ALERT_EMAIL: z.string().email().default('bursary@unn.edu.ng'),

    PAYMENT_REFERENCE_TTL_HOURS: z.coerce.number().int().positive().default(24),
    UNAPPLIED_RESOLUTION_DAYS: z.coerce.number().int().positive().default(90),

    PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
    ADMIN_ORIGINS: csv,
    APP_SCHEMES: csv,

    SENTRY_DSN: z.string().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

    // Worker cadence, overridable so tests can drive jobs directly.
    RECONCILE_CRON: z.string().default('*/10 * * * *'),
    OUTBOX_CRON: z.string().default('*/1 * * * *'),
    DAILY_MAINTENANCE_CRON: z.string().default('15 1 * * *'),

    // Run the worker's scheduled jobs inside the API process. Only for hosting
    // with no separate worker service (e.g. a free demo deployment).
    RUN_WORKER_IN_API: bool(false),

    CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
    CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production') {
      if (!cfg.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RESEND_API_KEY'],
          message: 'RESEND_API_KEY is required in production',
        });
      }
      if (cfg.ADMIN_ORIGINS.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_ORIGINS'],
          message: 'ADMIN_ORIGINS must list the admin dashboard origin in production',
        });
      }
      if (!cfg.PUBLIC_BASE_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_BASE_URL'],
          message: 'PUBLIC_BASE_URL must be https in production',
        });
      }
    }
  });

function load(env = process.env) {
  // On Render, fall back to the service's own public URL so a deployment whose
  // address is assigned at creation does not need it typed in by hand.
  const source =
    !env.PUBLIC_BASE_URL && env.RENDER_EXTERNAL_URL
      ? { ...env, PUBLIC_BASE_URL: env.RENDER_EXTERNAL_URL }
      : env;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Never print values; only the names of what is wrong.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const cfg = parsed.data;
  return {
    ...cfg,
    isProduction: cfg.NODE_ENV === 'production',
    isTest: cfg.NODE_ENV === 'test',
    isDevelopment: cfg.NODE_ENV === 'development',
    // Postgres over the public internet (Render's external URL) needs TLS; a
    // local socket does not. Default by environment, allow an explicit override.
    databaseSsl:
      cfg.DATABASE_SSL !== undefined ? cfg.DATABASE_SSL : cfg.NODE_ENV === 'production',
  };
}

const config = load();
config.load = load;
config.schema = schema;

module.exports = Object.freeze(config);
