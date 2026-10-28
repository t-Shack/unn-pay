'use strict';

const {
  signReceipt,
  verifyReceiptSignature,
  canonicalPayload,
  safeEqual,
} = require('../../src/lib/hmac');
const { backoffDelayMs, BACKOFF_SCHEDULE_MS, MAX_ATTEMPTS } = require('../../src/services/outboxService');
const { CircuitBreaker, CircuitOpenError } = require('../../src/adapters/bank/circuitBreaker');

const SECRET = 'test-signing-secret-'.padEnd(48, 'k');

const FIELDS = {
  receiptNumber: 'UNN/2025-2026/000123',
  unnReference: 'UNN250880118774',
  amount: '68500.00',
  issuedAt: new Date('2025-08-15T10:30:00.000Z'),
};

describe('Receipt signing (§8)', () => {
  it('signs over receipt number, reference, amount and issue time', () => {
    expect(canonicalPayload(FIELDS)).toBe(
      'UNN/2025-2026/000123|UNN250880118774|68500.00|2025-08-15T10:30:00.000Z'
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(signReceipt(FIELDS, SECRET)).toBe(signReceipt(FIELDS, SECRET));
  });

  it('verifies its own signature', () => {
    expect(verifyReceiptSignature(FIELDS, signReceipt(FIELDS, SECRET), SECRET)).toBe(true);
  });

  describe('tamper detection — the forged slip defence', () => {
    const signature = signReceipt(FIELDS, SECRET);

    it.each([
      ['amount', { amount: '685.00' }],
      ['amount by one kobo', { amount: '68500.01' }],
      ['receipt number', { receiptNumber: 'UNN/2025-2026/000124' }],
      ['payment reference', { unnReference: 'UNN250880118775' }],
      ['issue time', { issuedAt: new Date('2025-08-15T10:30:01.000Z') }],
    ])('rejects an edited %s', (_label, patch) => {
      expect(verifyReceiptSignature({ ...FIELDS, ...patch }, signature, SECRET)).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
      const forged = signReceipt(FIELDS, 'a-different-secret-'.padEnd(48, 'q'));
      expect(verifyReceiptSignature(FIELDS, forged, SECRET)).toBe(false);
    });

    it.each([['', 'empty'], [null, 'null'], ['deadbeef', 'truncated'], [undefined, 'missing']])(
      'rejects %p signature (%s)',
      (signatureValue) => {
        expect(verifyReceiptSignature(FIELDS, signatureValue, SECRET)).toBe(false);
      }
    );
  });

  it('requires every signed field', () => {
    expect(() => canonicalPayload({ ...FIELDS, amount: undefined })).toThrow();
    expect(() => canonicalPayload({ ...FIELDS, issuedAt: 'not a date' })).toThrow();
  });

  describe('safeEqual', () => {
    it('compares equal strings as equal and different ones as not', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
      expect(safeEqual('abc', 'abd')).toBe(false);
      expect(safeEqual('abc', 'abcd')).toBe(false);
    });
  });
});

describe('Outbox backoff scheduling (§9.3)', () => {
  it('follows the 1m, 5m, 15m, 1h, 6h schedule', () => {
    const noJitter = () => 0.5; // 0.5 maps to zero jitter
    expect(backoffDelayMs(0, noJitter)).toBe(60_000);
    expect(backoffDelayMs(1, noJitter)).toBe(300_000);
    expect(backoffDelayMs(2, noJitter)).toBe(900_000);
    expect(backoffDelayMs(3, noJitter)).toBe(3_600_000);
    expect(backoffDelayMs(4, noJitter)).toBe(21_600_000);
  });

  it('holds at 6 hours for attempts beyond the schedule', () => {
    const noJitter = () => 0.5;
    for (let attempt = 5; attempt < MAX_ATTEMPTS; attempt += 1) {
      expect(backoffDelayMs(attempt, noJitter)).toBe(21_600_000);
    }
  });

  it('applies jitter within ±20%, so retries do not synchronise', () => {
    const base = BACKOFF_SCHEDULE_MS[0];
    const delays = Array.from({ length: 400 }, () => backoffDelayMs(0));

    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(base * 0.8 - 1);
      expect(delay).toBeLessThanOrEqual(base * 1.2 + 1);
    }
    // Genuinely spread, not a constant.
    expect(new Set(delays).size).toBeGreaterThan(100);
  });

  it('never schedules a retry sooner than a second away', () => {
    expect(backoffDelayMs(0, () => 0)).toBeGreaterThanOrEqual(1000);
  });

  it('gives up after 8 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(8);
  });
});

describe('Circuit breaker (§9.4)', () => {
  const failing = () => Promise.reject(new Error('bank down'));
  const succeeding = () => Promise.resolve('ok');

  let now;
  let breaker;

  beforeEach(() => {
    now = 1_000_000;
    breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 5,
      cooldownMs: 60_000,
      clock: () => now,
    });
  });

  it('stays closed while calls succeed', async () => {
    for (let i = 0; i < 20; i += 1) await breaker.execute(succeeding);
    expect(breaker.state).toBe('closed');
  });

  it('opens after exactly 5 consecutive failures', async () => {
    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.execute(failing)).rejects.toThrow('bank down');
      expect(breaker.state).toBe('closed');
    }
    await expect(breaker.execute(failing)).rejects.toThrow('bank down');
    expect(breaker.state).toBe('open');
  });

  it('fails fast while open, without calling through', async () => {
    for (let i = 0; i < 5; i += 1) await breaker.execute(failing).catch(() => {});

    const call = jest.fn();
    await expect(breaker.execute(call)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(call).not.toHaveBeenCalled();
  });

  it('resets the failure count when a call succeeds in between', async () => {
    for (let i = 0; i < 4; i += 1) await breaker.execute(failing).catch(() => {});
    await breaker.execute(succeeding);
    expect(breaker.consecutiveFailures).toBe(0);

    for (let i = 0; i < 4; i += 1) await breaker.execute(failing).catch(() => {});
    expect(breaker.state).toBe('closed');
  });

  it('half opens after the 60 second cooldown and closes on first success', async () => {
    for (let i = 0; i < 5; i += 1) await breaker.execute(failing).catch(() => {});
    expect(breaker.state).toBe('open');

    now += 59_000;
    expect(breaker.canAttempt()).toBe(false);

    now += 2_000;
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.state).toBe('half_open');

    await breaker.execute(succeeding);
    expect(breaker.state).toBe('closed');
  });

  it('returns to open for a full cooldown when the probe fails', async () => {
    for (let i = 0; i < 5; i += 1) await breaker.execute(failing).catch(() => {});
    now += 61_000;

    await expect(breaker.execute(failing)).rejects.toThrow('bank down');
    expect(breaker.state).toBe('open');
    expect(breaker.retryAfterMs()).toBe(60_000);
  });

  it('reports a snapshot for the admin health panel', async () => {
    for (let i = 0; i < 5; i += 1) await breaker.execute(failing).catch(() => {});
    const snapshot = breaker.snapshot();

    expect(snapshot).toMatchObject({
      name: 'test',
      state: 'open',
      consecutive_failures: 5,
      failure_threshold: 5,
    });
    expect(snapshot.retry_at).toBeTruthy();
    expect(snapshot.last_error).toContain('bank down');
  });
});
