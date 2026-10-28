'use strict';

const fs = require('fs');
const path = require('path');

const { normaliseSettlement, PAYMENT_CHANNELS } = require('../../src/adapters/bank/types');
const { BankCollectionAdapter } = require('../../src/adapters/bank/BankCollectionAdapter');
const {
  GTBankAdapter,
  STATUS_MAP,
  CHANNEL_MAP,
  toBankDateTime,
  fromBankDateTime,
  loadGtbankConfig,
} = require('../../src/adapters/bank/gtbankAdapter');

/**
 * The bank abstraction (§5, §5.1).
 *
 * The specification states the acceptance criterion in the form of a code
 * review: "If a code review finds the string 'GTB' outside that one file and its
 * tests, the abstraction has failed." A convention nobody can run is a
 * convention that decays, so it is enforced here instead.
 */

const SRC = path.resolve(__dirname, '..', '..', 'src');
const ADAPTER_FILE = path.join(SRC, 'adapters', 'bank', 'gtbankAdapter.js');
const REGISTRY_FILE = path.join(SRC, 'adapters', 'bank', 'index.js');

function walk(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

describe('Bank abstraction (§5.1)', () => {
  const files = walk(SRC);

  it('has a source tree to check', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('mentions the bank nowhere but its own adapter and the registry', () => {
    const pattern = /gtb|guaranty/i;

    const offenders = files
      .filter((file) => file !== ADAPTER_FILE && file !== REGISTRY_FILE)
      .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));

    // The registry is the single permitted exception: the specification says
    // adding a bank means "writing one new file and changing one variable", and
    // that line is the variable.
    expect(offenders).toEqual([]);
  });

  it('confines the registry reference to a single contiguous factory entry', () => {
    const lines = fs.readFileSync(REGISTRY_FILE, 'utf8').split('\n');

    const mentioning = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /gtbank/i.test(line))
      .map(({ number }) => number);

    expect(mentioning.length).toBeGreaterThan(0);

    // Every mention sits inside one factory block — the "one line to change"
    // the specification allows when adding a bank — rather than being sprinkled
    // through the file.
    const span = mentioning[mentioning.length - 1] - mentioning[0] + 1;
    expect(span).toBeLessThanOrEqual(4);
    expect(mentioning.length).toBe(span);
  });

  it('declares the bank\'s own environment variables inside the adapter only', () => {
    const config = fs.readFileSync(path.join(SRC, 'config', 'index.js'), 'utf8');
    expect(config).not.toMatch(/GTBANK_/);

    const adapter = fs.readFileSync(ADAPTER_FILE, 'utf8');
    expect(adapter).toMatch(/GTBANK_API_BASE_URL/);
    expect(adapter).toMatch(/GTBANK_API_KEY/);
    expect(adapter).toMatch(/GTBANK_MERCHANT_ID/);
  });

  it('keeps every service free of any direct adapter import', () => {
    const services = walk(path.join(SRC, 'services'));
    for (const file of services) {
      const contents = fs.readFileSync(file, 'utf8');
      // Services may ask the factory for an adapter; they may never construct one.
      expect(contents).not.toMatch(/require\(.*(gtbankAdapter|sandboxAdapter)/);
    }
  });
});

describe('NormalisedSettlement contract (§5)', () => {
  const valid = {
    providerReference: 'STL-001',
    unnReference: 'UNN250880118774',
    amountPaid: '68500.00',
    currency: 'NGN',
    channel: 'transfer',
    status: 'successful',
    paidAt: new Date('2025-08-15T10:00:00Z'),
  };

  it('converts money to integer kobo at the boundary', () => {
    expect(normaliseSettlement(valid).amountPaidKobo).toBe(6850000);
  });

  it('uppercases and trims the UNN reference', () => {
    const settlement = normaliseSettlement({ ...valid, unnReference: '  unn250880118774 ' });
    expect(settlement.unnReference).toBe('UNN250880118774');
  });

  it('returns a frozen object, so nothing downstream can mutate a settlement', () => {
    const settlement = normaliseSettlement(valid);
    expect(Object.isFrozen(settlement)).toBe(true);
  });

  it.each([
    ['a missing provider reference', { providerReference: '' }],
    ['a foreign currency', { currency: 'USD' }],
    ['an unknown channel', { channel: 'carrier_pigeon' }],
    ['an unknown status', { status: 'maybe' }],
    ['an unparseable date', { paidAt: 'not a date' }],
    ['a negative amount', { amountPaid: '-1.00' }],
    ['a sub kobo amount', { amountPaid: '1.005' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => normaliseSettlement({ ...valid, ...patch })).toThrow(/invalid settlement/i);
  });

  it('supports every channel the specification requires (§5.2)', () => {
    expect([...PAYMENT_CHANNELS].sort()).toEqual(
      ['bank_branch', 'card', 'pos', 'transfer', 'ussd'].sort()
    );
  });
});

describe('The adapter interface', () => {
  it('refuses to be used unimplemented', async () => {
    const bare = new BankCollectionAdapter();
    expect(() => bare.name).toThrow();
    await expect(bare.mintVirtualAccount({})).rejects.toThrow(/not implemented/);
    await expect(bare.fetchSettlement('x')).rejects.toThrow(/not implemented/);
    await expect(bare.listSettlements({})).rejects.toThrow(/not implemented/);
    expect(() => bare.verifySignature(Buffer.from(''), {})).toThrow(/not implemented/);
    expect(() => bare.parseWebhook(Buffer.from(''))).toThrow(/not implemented/);
  });
});

describe('GTBankAdapter translation', () => {
  const env = {
    GTBANK_API_BASE_URL: 'https://api.example.test',
    GTBANK_API_KEY: 'test-key',
    GTBANK_MERCHANT_ID: 'UNN-TEST',
  };

  const adapter = new GTBankAdapter({ env, fetchImpl: async () => {
    throw new Error('no network in tests');
  } });

  it('refuses to construct without its own configuration', () => {
    expect(() => new GTBankAdapter({ env: {} })).toThrow(/not configured/i);
  });

  it('maps every status the bank can report onto ours', () => {
    for (const [theirs, ours] of Object.entries(STATUS_MAP)) {
      expect(['successful', 'pending', 'failed']).toContain(ours);
      expect(typeof theirs).toBe('string');
    }
  });

  it('maps every channel onto one the system understands', () => {
    for (const ours of Object.values(CHANNEL_MAP)) {
      expect(PAYMENT_CHANNELS).toContain(ours);
    }
  });

  it('translates a settlement payload into the normalised shape', () => {
    const settlement = adapter._translateSettlement({
      transactionReference: 'GTB-TXN-99',
      merchantReference: 'UNN250880118774',
      amountPaid: '68500.00',
      currency: 'NGN',
      channel: 'NIP',
      status: 'SUCCESS',
      transactionDate: '2025-08-15 10:30:00',
      originatorAccountName: 'CHIDERA OKONKWO',
      originatorBankName: 'Zenith Bank',
    });

    expect(settlement).toMatchObject({
      providerReference: 'GTB-TXN-99',
      unnReference: 'UNN250880118774',
      amountPaidKobo: 6850000,
      currency: 'NGN',
      channel: 'transfer',
      status: 'successful',
      payerAccountName: 'CHIDERA OKONKWO',
      payerBank: 'Zenith Bank',
    });
    expect(settlement.paidAt.toISOString()).toBe('2025-08-15T10:30:00.000Z');
    // The raw payload is retained verbatim for audit (§5).
    expect(settlement.rawPayload.transactionReference).toBe('GTB-TXN-99');
  });

  it('refuses a status it has no mapping for, rather than guessing', () => {
    expect(() =>
      adapter._translateSettlement({
        transactionReference: 'X',
        merchantReference: 'UNN250880118774',
        amountPaid: '1.00',
        status: 'SOMETHING_NEW',
        transactionDate: '2025-08-15 10:30:00',
      })
    ).toThrow(/Unmapped bank settlement status/);
  });

  it('round trips the bank\'s date format', () => {
    const date = new Date('2025-08-15T10:30:00.000Z');
    expect(toBankDateTime(date)).toBe('2025-08-15 10:30:00');
    expect(fromBankDateTime('2025-08-15 10:30:00').toISOString()).toBe(date.toISOString());
    // ISO 8601 is accepted too, in case the real API returns it.
    expect(fromBankDateTime('2025-08-15T10:30:00Z').toISOString()).toBe(date.toISOString());
  });

  it('rejects a webhook with no signature headers', () => {
    expect(adapter.verifySignature(Buffer.from('{}'), {})).toBe(false);
  });

  it('validates its configuration by name, never leaking values', () => {
    try {
      loadGtbankConfig({ GTBANK_API_KEY: 'super-secret-value' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.message).toMatch(/GTBANK_API_BASE_URL/);
      expect(error.message).not.toContain('super-secret-value');
    }
  });
});
