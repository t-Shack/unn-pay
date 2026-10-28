'use strict';

const { DeviceToken } = require('../../models');
const config = require('../../config');
const { logger } = require('../../config/logger');

/**
 * Firebase Cloud Messaging (§3, §11.5).
 *
 * Behind an interface for the same reason everything external is. With no
 * FIREBASE_SERVICE_ACCOUNT_JSON configured this degrades to a no-op that reports
 * what it would have sent, so development and the test suite never reach out to
 * Google.
 *
 * Tokens that FCM reports as permanently invalid are deleted here. A device that
 * has been wiped or reinstalled leaves a dead token behind, and left alone those
 * accumulate until every send is mostly failures.
 */

let messaging = null;
let initialised = false;

function init() {
  if (initialised) return messaging;
  initialised = true;

  if (!config.FIREBASE_SERVICE_ACCOUNT_JSON) {
    logger.warn('no FIREBASE_SERVICE_ACCOUNT_JSON set; push notifications are disabled');
    return null;
  }

  try {
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    const credential = JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON);
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(credential) });
    messaging = admin.messaging(app);
    logger.info({ project: credential.project_id }, 'firebase messaging initialised');
    return messaging;
  } catch (error) {
    logger.error({ err: error.message }, 'firebase initialisation failed; push is disabled');
    return null;
  }
}

const PERMANENT_FAILURES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Send one notification to every device a student has registered.
 *
 * @param {number} studentId
 * @param {{title: string, body: string, data?: Record<string,string>}} message
 */
async function sendToStudent(studentId, { title, body, data = {} }) {
  const devices = await DeviceToken.findAll({ where: { student_id: studentId } });
  if (devices.length === 0) return { sent: 0, failed: 0, skipped: 'no_devices' };

  const client = init();
  if (!client) {
    logger.info({ student_id: studentId, title }, 'push suppressed (FCM not configured)');
    return { sent: 0, failed: 0, skipped: 'not_configured', devices: devices.length };
  }

  // FCM data values must all be strings.
  const stringData = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value ?? '')])
  );

  const response = await client.sendEachForMulticast({
    tokens: devices.map((device) => device.fcm_token),
    notification: { title, body },
    data: stringData,
    android: { priority: 'high', notification: { channelId: 'unn_pay_payments' } },
    apns: { payload: { aps: { sound: 'default' } } },
  });

  const staleTokens = [];
  response.responses.forEach((result, index) => {
    if (!result.success && result.error && PERMANENT_FAILURES.has(result.error.code)) {
      staleTokens.push(devices[index].fcm_token);
    }
  });

  if (staleTokens.length > 0) {
    await DeviceToken.destroy({ where: { fcm_token: staleTokens } });
    logger.info({ count: staleTokens.length }, 'removed stale device tokens');
  }

  return {
    sent: response.successCount,
    failed: response.failureCount,
    removed: staleTokens.length,
  };
}

const isConfigured = () => Boolean(config.FIREBASE_SERVICE_ACCOUNT_JSON);

module.exports = { sendToStudent, init, isConfigured };
