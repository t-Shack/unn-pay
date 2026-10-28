'use strict';

const express = require('express');
const { z } = require('zod');
const { DeviceToken } = require('../../models');
const asyncHandler = require('../../middleware/asyncHandler');
const validate = require('../../middleware/validate');
const { requireStudent } = require('../../middleware/auth');

/**
 * Device registration for push notifications (§11.5).
 *
 * The upsert is keyed on the FCM token, not on the student: a shared or handed
 * on device must follow its current owner, so re-registering an existing token
 * moves it rather than creating a second row pointing at the previous student.
 */
const router = express.Router();

const registerSchema = z.object({
  fcm_token: z.string().trim().min(20).max(255),
  platform: z.enum(['android', 'ios']),
});

const unregisterSchema = z.object({ fcm_token: z.string().trim().min(20).max(255) });

router.post(
  '/register-device',
  requireStudent,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const [record] = await DeviceToken.upsert(
      {
        student_id: req.student.student_id,
        fcm_token: req.body.fcm_token,
        platform: req.body.platform,
        last_seen_at: new Date(),
      },
      { conflictFields: ['fcm_token'], returning: true }
    );

    res.status(200).json({
      device: {
        device_token_id: record.device_token_id,
        platform: record.platform,
        last_seen_at: record.last_seen_at,
      },
    });
  })
);

router.delete(
  '/register-device',
  requireStudent,
  validate({ body: unregisterSchema }),
  asyncHandler(async (req, res) => {
    const removed = await DeviceToken.destroy({
      where: { fcm_token: req.body.fcm_token, student_id: req.student.student_id },
    });
    res.status(200).json({ removed });
  })
);

module.exports = router;
