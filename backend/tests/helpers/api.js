'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const bankAdapters = require('../../src/adapters/bank');
const emailProvider = require('../../src/adapters/email');
const { db } = require('./setup');

/**
 * Shared harness for the integration and concurrency suites: one app instance,
 * direct access to the sandbox bank behind the resilient wrapper, and helpers
 * for the flows every test needs (activate a student, mint a reference, deliver
 * a webhook).
 */

const app = createApp();
const api = () => request(app);

/** The raw SandboxAdapter, unwrapped from the circuit breaker layer. */
function sandbox() {
  const adapter = bankAdapters.get('sandbox');
  return adapter.inner || adapter;
}

/** The resilient wrapper itself, for inspecting or resetting the circuit. */
const resilient = () => bankAdapters.get('sandbox');

const email = () => emailProvider.get();

function resetAdapters() {
  sandbox().clearFaults();
  const wrapper = resilient();
  if (wrapper.breaker) wrapper.breaker.reset();
  if (email().clear) email().clear();
}

/**
 * Activate an imported student through the real endpoints, reading the OTP from
 * the console email provider — the OTP is bcrypt hashed at rest, so this is the
 * only way to obtain it, exactly as a student would from their inbox.
 */
async function activateStudent(student, password = 'Password123') {
  await api()
    .post('/api/v1/auth/activate/request')
    .send({ matric_number: student.matric_number })
    .expect(202);

  await drainOutbox();

  const message = email().lastOfKind('activation_otp', student.email);
  if (!message) throw new Error(`No activation email was queued for ${student.matric_number}`);

  const response = await api()
    .post('/api/v1/auth/activate/confirm')
    .send({
      matric_number: student.matric_number,
      code: message.payload.code,
      password,
    })
    .expect(200);

  return { tokens: response.body.tokens, otp: message.payload.code };
}

/** Sign in an already active student. */
async function loginStudent(student, password = 'Password123') {
  const response = await api()
    .post('/api/v1/auth/login')
    .send({ matric_number: student.matric_number, password })
    .expect(200);
  return response.body.tokens;
}

async function loginAdmin(admin, password = 'AdminPassword123') {
  const response = await api()
    .post('/api/v1/admin/login')
    .send({ email: admin.email, password })
    .expect(200);
  return response.body.tokens;
}

const auth = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

/**
 * Start a payment. Returns the supertest chain rather than awaiting it, so a
 * caller can still attach `.expect(...)`.
 */
function initiatePayment(tokens, feeItemId, headers = {}) {
  return api()
    .post('/api/v1/payments/initiate')
    .set(auth(tokens))
    .set(headers)
    .send({ fee_item_id: feeItemId });
}

/**
 * Deliver a signed webhook exactly as the bank would, through the real route.
 * `times` delivers the identical envelope repeatedly, to prove idempotency.
 */
async function deliverWebhook(webhook, { times = 1 } = {}) {
  const responses = [];
  for (let i = 0; i < times; i += 1) {
    responses.push(
      await api()
        .post('/api/v1/webhooks/bank')
        .set(webhook.headers)
        .set('Content-Type', 'application/json')
        // The body must go over the wire byte for byte. Passing a Buffer here
        // would make supertest JSON-serialise it into {"type":"Buffer",...},
        // which is a different payload and would fail signature verification —
        // correctly, since that is exactly what the signature is for.
        .send(webhook.body)
    );
  }
  return responses;
}

/** Run the outbox worker job to completion, so queued side effects happen. */
async function drainOutbox({ passes = 3 } = {}) {
  const { runOutboxDrain } = require('../../src/worker/jobs/outboxDrain');
  const results = [];
  for (let i = 0; i < passes; i += 1) {
    const result = await runOutboxDrain({ batchSize: 100 });
    results.push(result);
    if (result.claimed === 0) break;
  }
  return results;
}

const reload = (instance) => instance.reload();

module.exports = {
  app,
  api,
  sandbox,
  resilient,
  email,
  resetAdapters,
  activateStudent,
  loginStudent,
  loginAdmin,
  auth,
  initiatePayment,
  deliverWebhook,
  drainOutbox,
  reload,
  db,
};
