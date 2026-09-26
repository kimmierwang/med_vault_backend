import { Router } from 'express';
import { Drug } from '../models/index.js';
import { asyncHandler } from '../utils/http.js';
import { listAlertViews } from '../services/alerts.js';

const router = Router();

// Home screen (§4.1.1): totals + the "Needs attention" list.
router.get('/', asyncHandler(async (req, res) => {
  const [drugsTracked, alerts] = await Promise.all([
    Drug.countDocuments({ userId: { $in: req.userIds } }),
    listAlertViews(req.userIds, { status: 'Open' }),
  ]);
  res.json({
    drugsTracked,
    expiringSoon: alerts.filter((a) => a.alertType === 'expiry' && a.alertTier !== 'expired').length,
    expired: alerts.filter((a) => a.alertType === 'expiry' && a.alertTier === 'expired').length,
    lowStock: alerts.filter((a) => a.alertType === 'low_stock').length,
    openAlerts: alerts.length,
    needsAttention: alerts.slice(0, 5),
  });
}));

export default router;
