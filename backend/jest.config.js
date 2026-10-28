'use strict';

/**
 * The suite runs against a real PostgreSQL instance started in globalSetup
 * (§14). Tests run serially: they share one database, and the concurrency suite
 * is deliberately racing rows inside it.
 */
module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.js',
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/scripts/**',
    '!src/db/migrations/**',
    '!src/server.js',
    '!src/worker/index.js',
  ],
  coverageThreshold: {
    // Services carry the business logic and are held to the specification's bar.
    './src/services/': { statements: 80, branches: 65, functions: 80, lines: 80 },
  },
  testTimeout: 30000,
  maxWorkers: 1,
  verbose: false,
};
