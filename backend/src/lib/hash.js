'use strict';

const bcrypt = require('bcryptjs');

/**
 * Password and OTP hashing (§13.2). bcrypt cost 12 for every secret at rest:
 * student passwords, admin passwords, and activation and reset OTPs.
 *
 * Kept behind this module so the cost factor is defined once and so a future
 * move to a native bcrypt binding or argon2 is a single file change.
 */
const BCRYPT_COST = 12;

const hashSecret = (plain) => bcrypt.hash(plain, BCRYPT_COST);
const verifySecret = (plain, hash) => (hash ? bcrypt.compare(plain, hash) : Promise.resolve(false));

/**
 * Compare against a throwaway hash so a request for a non existent account
 * costs the same as one for a real account. Without this, response timing tells
 * an attacker which matric numbers and staff ids exist.
 */
const DUMMY_HASH = bcrypt.hashSync('unn-pay-timing-equaliser', BCRYPT_COST);
async function verifyWithTimingEqualiser(plain, hash) {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

module.exports = { BCRYPT_COST, hashSecret, verifySecret, verifyWithTimingEqualiser };
