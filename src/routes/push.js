import { Router } from 'express';
import { Expo } from 'expo-server-sdk';
import { z } from 'zod';
import { DeviceToken } from '../models/index.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

const tokenSchema = z.object({
  token: z.string().refine((t) => Expo.isExpoPushToken(t), 'Not a valid Expo push token'),
  enabled: z.boolean().default(true),
});

// The app registers its Expo push token after login; `enabled` mirrors the "Push notifications" switch.
router.post('/token', validate(tokenSchema), asyncHandler(async (req, res) => {
  const { token, enabled } = req.body;
  await DeviceToken.findOneAndUpdate({ token }, { $set: { userId: req.user._id, enabled } }, { upsert: true, new: true });
  res.status(201).json({ registered: true, enabled });
}));

router.delete('/token', validate(z.object({ token: z.string().min(1) })), asyncHandler(async (req, res) => {
  await DeviceToken.deleteOne({ token: req.body.token, userId: req.user._id });
  res.json({ removed: true });
}));

export default router;
