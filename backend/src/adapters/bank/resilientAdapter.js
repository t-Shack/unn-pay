'use strict';

const { BankCollectionAdapter } = require('./BankCollectionAdapter');
const { CircuitBreaker, CircuitOpenError } = require('./circuitBreaker');
const { BankUnavailableError } = require('../../lib/errors');
const { logger } = require('../../config/logger');
const config = require('../../config');

/**
 * Wraps any BankCollectionAdapter with the resilience the specification requires
 * (§9.4), without any of it leaking into business logic or into the adapters
 * themselves:
 *
 *  - a circuit breaker over every network call
 *  - a hard timeout, so a hanging bank cannot hold a student's request open
 *  - normalisation of every failure into BankUnavailableError, so callers never
 *    branch on a bank specific error shape
 *
 * verifySignature and parseWebhook are pure and local, so they pass straight
 * through: there is nothing to break and nothing to time out.
 */
class ResilientBankAdapter extends BankCollectionAdapter {
  /**
   * @param {BankCollectionAdapter} inner
   * @param {{breaker?: CircuitBreaker, timeoutMs?: number}} [options]
   */
  constructor(inner, { breaker, timeoutMs = 20000 } = {}) {
    super();
    this.inner = inner;
    this.timeoutMs = timeoutMs;
    this.breaker =
      breaker ||
      new CircuitBreaker({
        name: `bank:${inner.name}`,
        failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        cooldownMs: config.CIRCUIT_BREAKER_COOLDOWN_MS,
      });
  }

  get name() {
    return this.inner.name;
  }

  get displayName() {
    return this.inner.displayName;
  }

  async _guard(method, fn) {
    try {
      return await this.breaker.execute(() => withTimeout(fn(), this.timeoutMs, method));
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        logger.warn({ method, adapter: this.name }, 'bank call short circuited');
        throw new BankUnavailableError('The bank is temporarily unreachable', {
          code: 'bank_circuit_open',
          cause: error,
        });
      }
      logger.error(
        { method, adapter: this.name, err: error.message },
        'bank call failed'
      );
      throw new BankUnavailableError(`Bank call ${method} failed`, {
        code: 'bank_call_failed',
        cause: error,
      });
    }
  }

  mintVirtualAccount(params) {
    return this._guard('mintVirtualAccount', () => this.inner.mintVirtualAccount(params));
  }

  fetchSettlement(providerReference) {
    return this._guard('fetchSettlement', () => this.inner.fetchSettlement(providerReference));
  }

  fetchSettlementByReference(unnReference) {
    if (typeof this.inner.fetchSettlementByReference !== 'function') return Promise.resolve(null);
    return this._guard('fetchSettlementByReference', () =>
      this.inner.fetchSettlementByReference(unnReference)
    );
  }

  listSettlements(params) {
    return this._guard('listSettlements', () => this.inner.listSettlements(params));
  }

  releaseVirtualAccount(providerReference) {
    return this._guard('releaseVirtualAccount', () =>
      this.inner.releaseVirtualAccount(providerReference)
    );
  }

  // Pure, local, no network: pass straight through.
  verifySignature(rawBody, headers) {
    return this.inner.verifySignature(rawBody, headers);
  }

  parseWebhook(rawBody) {
    return this.inner.parseWebhook(rawBody);
  }

  async healthCheck() {
    // Reports rather than throws: the readiness probe wants a status, and an
    // open circuit is a legitimate answer, not an exception.
    if (this.breaker.state === 'open') {
      return { ok: false, detail: 'circuit open', circuit: this.breaker.snapshot() };
    }
    try {
      const result = await withTimeout(this.inner.healthCheck(), 5000, 'healthCheck');
      return { ...result, circuit: this.breaker.snapshot() };
    } catch (error) {
      return { ok: false, detail: error.message, circuit: this.breaker.snapshot() };
    }
  }

  circuitSnapshot() {
    return this.breaker.snapshot();
  }
}

/** Reject after `ms` so one hanging call cannot occupy a request indefinitely. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { ResilientBankAdapter, withTimeout };
