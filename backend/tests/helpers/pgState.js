'use strict';

const os = require('os');
const path = require('path');

/**
 * Where globalSetup records the connection details of the PostgreSQL instance it
 * started. Kept in its own module because `pg.js` imports embedded-postgres,
 * which is ESM and cannot be required from inside a Jest test file.
 */
const STATE_FILE = path.join(os.tmpdir(), 'unn-pay-test-pg.json');

module.exports = { STATE_FILE };
