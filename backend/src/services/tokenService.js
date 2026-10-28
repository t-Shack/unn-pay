'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { RefreshToken, sequelize } = require('../models');
const { sha256 } = require('../lib/hmac');
const { UnauthorizedError } = require('../lib/errors');
const { logger } = require('../config/logger');
const config = require('../config');

/**
 * Access and refresh tokens (§13.3).
 *
 * Access tokens are short lived (15 minutes) and stateless. Refresh tokens are
 * long lived (7 days), opaque, stored only as a SHA-256 hash, and rotated on
 * every use. Every token descended from one login shares a family id, so
 * presenting a refresh token that has already been consumed — the signature of a
 * stolen token being replayed — revokes the entire family at once, logging out
 * the thief and the victim together rather than letting both continue.
 *
 * The refresh token is hashed with SHA-256 rather than bcrypt because it is a
 * 256 bit random value, not a human chosen password: there is nothing to brute
 * force, and the lookup has to be a single indexed query.
 */

const ISSUER = 'unn-pay';
const AUDIENCE = { STUDENT: 'unn-pay-student', ADMIN: 'unn-pay-admin' };

function accessSecretFor() {
  return config.JWT_ACCESS_SECRET;
}

/** Sign a short lived access token. */
function signAccessToken({ subjectType, subjectId, extra = {} }) {
  return jwt.sign(
    { sub: String(subjectId), typ: subjectType, ...extra },
    accessSecretFor(),
    {
      issuer: ISSUER,
      audience: subjectType === 'admin' ? AUDIENCE.ADMIN : AUDIENCE.STUDENT,
      expiresIn: `${config.ACCESS_TOKEN_TTL_MINUTES}m`,
    }
  );
}

function verifyAccessToken(token, expectedType) {
  try {
    const payload = jwt.verify(token, accessSecretFor(), {
      issuer: ISSUER,
      audience: expectedType === 'admin' ? AUDIENCE.ADMIN : AUDIENCE.STUDENT,
    });
    if (payload.typ !== expectedType) {
      throw new UnauthorizedError('Token is not valid for this endpoint', 'wrong_token_type');
    }
    return payload;
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    if (error.name === 'TokenExpiredError') {
      throw new UnauthorizedError('Your session has expired', 'token_expired');
    }
    throw new UnauthorizedError('Invalid token', 'invalid_token');
  }
}

/** 256 bits of entropy, URL safe. */
const newOpaqueToken = () => crypto.randomBytes(32).toString('base64url');

function refreshExpiry(from = new Date()) {
  return new Date(from.getTime() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Issue a fresh token pair, starting a new family (a login).
 */
async function issueTokenPair({ subjectType, subjectId, extra, userAgent, ipAddress }, options = {}) {
  const familyId = crypto.randomUUID();
  const refreshToken = newOpaqueToken();

  await RefreshToken.create(
    {
      subject_type: subjectType,
      subject_id: subjectId,
      family_id: familyId,
      token_hash: sha256(refreshToken),
      expires_at: refreshExpiry(),
      user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
      ip_address: ipAddress || null,
    },
    { transaction: options.transaction }
  );

  return {
    access_token: signAccessToken({ subjectType, subjectId, extra }),
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: config.ACCESS_TOKEN_TTL_MINUTES * 60,
  };
}

/**
 * Rotate a refresh token.
 *
 * Presenting a token that was already consumed means the token leaked: the
 * legitimate holder rotated it, and someone else is now replaying the old one.
 * There is no way to tell which caller is which, so the whole family is revoked.
 */
async function rotateRefreshToken({ token, subjectType, userAgent, ipAddress }) {
  if (!token || typeof token !== 'string') {
    throw new UnauthorizedError('Refresh token is required', 'refresh_token_required');
  }
  const hash = sha256(token);

  // The rotation runs in a transaction, but a detected reuse must NOT: throwing
  // out of a managed transaction rolls it back, which would undo the very
  // revocation the detection exists to perform. So the transaction reports what
  // it found, and the revocation and the error happen outside it.
  const outcome = await sequelize.transaction(async (t) => {
    const existing = await RefreshToken.findOne({
      where: { token_hash: hash },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!existing || existing.subject_type !== subjectType) {
      return { verdict: 'unknown' };
    }
    if (existing.consumed_at) {
      return { verdict: 'reused', familyId: existing.family_id, subjectId: existing.subject_id };
    }
    if (existing.revoked_at) return { verdict: 'revoked' };
    if (existing.expires_at <= new Date()) return { verdict: 'expired' };

    const replacement = newOpaqueToken();
    await existing.update({ consumed_at: new Date() }, { transaction: t });
    await RefreshToken.create(
      {
        subject_type: existing.subject_type,
        subject_id: existing.subject_id,
        family_id: existing.family_id,
        token_hash: sha256(replacement),
        expires_at: refreshExpiry(),
        user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
        ip_address: ipAddress || null,
      },
      { transaction: t }
    );

    return {
      verdict: 'rotated',
      subjectId: existing.subject_id,
      tokens: {
        access_token: signAccessToken({
          subjectType: existing.subject_type,
          subjectId: existing.subject_id,
        }),
        refresh_token: replacement,
        token_type: 'Bearer',
        expires_in: config.ACCESS_TOKEN_TTL_MINUTES * 60,
      },
    };
  });

  if (outcome.verdict === 'rotated') {
    return { subjectId: outcome.subjectId, tokens: outcome.tokens };
  }

  if (outcome.verdict === 'reused') {
    // Someone is replaying a token the legitimate holder already rotated away.
    // There is no way to tell which caller is which, so the entire family goes.
    await RefreshToken.update(
      { revoked_at: new Date(), revoked_reason: 'refresh_token_reuse_detected' },
      { where: { family_id: outcome.familyId, revoked_at: null } }
    );
    logger.warn(
      { family_id: outcome.familyId, subject_type: subjectType, subject_id: outcome.subjectId },
      'refresh token reuse detected; family revoked'
    );
    throw new UnauthorizedError(
      'This session has been revoked. Please sign in again.',
      'refresh_token_reused'
    );
  }

  if (outcome.verdict === 'revoked') {
    throw new UnauthorizedError('This session has been revoked', 'refresh_token_revoked');
  }
  if (outcome.verdict === 'expired') {
    throw new UnauthorizedError('Your session has expired', 'refresh_token_expired');
  }
  throw new UnauthorizedError('Invalid refresh token', 'invalid_refresh_token');
}

/** Logout: revoke the presented token's whole family. */
async function revokeRefreshToken(token, { reason = 'logout' } = {}) {
  if (!token) return 0;
  const existing = await RefreshToken.findOne({ where: { token_hash: sha256(token) } });
  if (!existing) return 0;
  const [count] = await RefreshToken.update(
    { revoked_at: new Date(), revoked_reason: reason },
    { where: { family_id: existing.family_id, revoked_at: null } }
  );
  return count;
}

/** Used when a password changes: every existing session must die. */
async function revokeAllForSubject(subjectType, subjectId, { reason = 'password_changed', transaction } = {}) {
  const [count] = await RefreshToken.update(
    { revoked_at: new Date(), revoked_reason: reason },
    { where: { subject_type: subjectType, subject_id: subjectId, revoked_at: null }, transaction }
  );
  return count;
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForSubject,
  newOpaqueToken,
  ISSUER,
  AUDIENCE,
};
