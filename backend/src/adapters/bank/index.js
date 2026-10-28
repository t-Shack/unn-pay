'use strict';

const config = require('../../config');
const { ResilientBankAdapter } = require('./resilientAdapter');
const { logger } = require('../../config/logger');

/**
 * Adapter selection (§5).
 *
 * Adding a bank means writing one new file and adding one line to REGISTRY.
 * Nothing else in the codebase changes, and nothing else may import a concrete
 * adapter directly — everyone asks this factory.
 *
 * Selection is per name rather than global-only, so the redundancy design the
 * specification wants left open (two banks concurrently, chosen at mint time)
 * is a router in front of `get(name)`, not a rewrite.
 */

const REGISTRY = {
  sandbox: () => {
    const { SandboxAdapter } = require('./sandboxAdapter');
    return new SandboxAdapter();
  },
  gtbank: () => {
    const { GTBankAdapter } = require('./gtbankAdapter');
    return new GTBankAdapter();
  },
};

/** name -> wrapped adapter instance. Built once, reused for the process life. */
const instances = new Map();

/**
 * Get an adapter by name, wrapped in the circuit breaker and timeout layer.
 * @param {string} [name] defaults to BANK_ADAPTER
 * @returns {import('./BankCollectionAdapter').BankCollectionAdapter}
 */
function get(name = config.BANK_ADAPTER) {
  if (instances.has(name)) return instances.get(name);

  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(
      `Unknown bank adapter "${name}". Available: ${Object.keys(REGISTRY).join(', ')}`
    );
  }

  const adapter = new ResilientBankAdapter(factory());
  instances.set(name, adapter);
  logger.info({ adapter: name, displayName: adapter.displayName }, 'bank adapter initialised');
  return adapter;
}

/** The adapter new transactions are minted against right now. */
const getDefault = () => get(config.BANK_ADAPTER);

/**
 * Get the adapter a specific transaction was minted against. A settlement must
 * always be interpreted by the adapter that created it, even after the default
 * has been switched to another bank.
 */
const getForTransaction = (transaction) =>
  get(transaction && transaction.adapter ? transaction.adapter : config.BANK_ADAPTER);

const availableAdapters = () => Object.keys(REGISTRY);

/** Test hook: drop cached instances so a suite can re-create them. */
function resetForTests() {
  instances.clear();
}

module.exports = { get, getDefault, getForTransaction, availableAdapters, resetForTests, REGISTRY };
