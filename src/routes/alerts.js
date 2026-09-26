import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import { listAlertViews, reconcile } from '../services/alerts.js';

const router = Router();

const listQuery = z.object({
  status: z.enum(['Open', 'Resolved']).optional(),
  type: z.enum(['expiry', 'low_stock']).optional(),
  tier: z.enum(['upcoming', 'warning', 'critical', 'expired']).optional(),
});

// Alerts screen: ?status=Open (default view) or Resolved; filter chips = tier / type.
router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { status = 'Open', type, tier } = req.query;
  const [alerts, open, resolved] = await Promise.all([
    listAlertViews(req.userIds, { status, type, tier }),
    listAlertViews(req.userIds, { status: 'Open' }),
    listAlertViews(req.userIds, { status: 'Resolved' }),
  ]);
  const counts = { all: open.length, low_stock: open.filter((a) => a.alertType === 'low_stock').length, resolved: resolved.length };
  ['critical', 'warning', 'expired', 'upcoming'].forEach((t) => { counts[t] = open.filter((a) => a.alertType === 'expiry' && a.alertTier === t).length; });
  res.json({ alerts, counts });
}));

// Re-check everything now (pull-to-refresh).
router.post('/refresh', asyncHandler(async (req, res) => {
  res.json(await reconcile(req.userIds));
}));

export default router;
