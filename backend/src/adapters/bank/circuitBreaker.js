'use strict';

const { logger } = require('../../config/logger');

/**
 * Circuit breaker for the bank adapter (§9.4).
 *
 * After N consecutive failures the circuit opens for a cooldown and calls fail
 * fast instead of piling up against a bank that is already struggling. After the
 * cooldown it half opens: one probe call is allowed through, and the first
 * success closes it again.
 *
 * The state is per process and deliberately in memory. It is a fast local
 * reflex, not a distributed consensus; sharing it across instances would add a
 * network dependency to the thing whose job is to survive network failure.
 */

const STATE = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' });

class CircuitOpenError extends Error {
  constructor(name, retryAfterMs) {
    super(`Circuit for ${name} is open; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
    this.circuitOpen = true;
  }
}

class CircuitBreaker {
  constructor({ name = 'bank', failureThreshold = 5, cooldownMs = 60000, clock = Date.now } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.clock = clock;

    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastError = null;
    this.lastStateChangeAt = clock();
    // Set while a half open probe is in flight, so only one call gets through.
    this.probeInFlight = false;
  }

  /** Snapshot for the admin health panel (§9.6). */
  snapshot() {
    return {
      name: this.name,
      state: this.state,
      consecutive_failures: this.consecutiveFailures,
      failure_threshold: this.failureThreshold,
      opened_at: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      cooldown_ms: this.cooldownMs,
      retry_at:
        this.state === STATE.OPEN ? new Date(this.openedAt + this.cooldownMs).toISOString() : null,
      last_error: this.lastError,
      last_state_change_at: new Date(this.lastStateChangeAt).toISOString(),
    };
  }

  _transition(next) {
    if (this.state === next) return;
    logger.warn(
      { circuit: this.name, from: this.state, to: next, failures: this.consecutiveFailures },
      'circuit breaker state change'
    );
    this.state = next;
    this.lastStateChangeAt = this.clock();
  }

  /** True when a call may proceed right now. */
  canAttempt() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.OPEN) {
      if (this.clock() - this.openedAt >= this.cooldownMs) {
        this._transition(STATE.HALF_OPEN);
        this.probeInFlight = false;
        return true;
      }
      return false;
    }
    // Half open: admit exactly one probe at a time.
    return !this.probeInFlight;
  }

  retryAfterMs() {
    if (this.state !== STATE.OPEN) return 0;
    return Math.max(0, this.openedAt + this.cooldownMs - this.clock());
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.probeInFlight = false;
    this.openedAt = null;
    this._transition(STATE.CLOSED);
  }

  recordFailure(error) {
    this.consecutiveFailures += 1;
    this.lastError = error ? String(error.message || error).slice(0, 200) : 'unknown';
    this.probeInFlight = false;

    // A failed probe sends us straight back to open for another full cooldown.
    if (this.state === STATE.HALF_OPEN || this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = this.clock();
      this._transition(STATE.OPEN);
    }
  }

  /** Wrap a call. Throws CircuitOpenError without invoking `fn` while open. */
  async execute(fn) {
    if (!this.canAttempt()) {
      throw new CircuitOpenError(this.name, this.retryAfterMs());
    }
    if (this.state === STATE.HALF_OPEN) this.probeInFlight = true;

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  reset() {
    this.state = STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastError = null;
    this.probeInFlight = false;
    this.lastStateChangeAt = this.clock();
  }
}

module.exports = { CircuitBreaker, CircuitOpenError, STATE };
