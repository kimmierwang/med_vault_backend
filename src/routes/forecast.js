import { Router } from 'express';
import { z } from 'zod';
import { Batch, Drug } from '../models/index.js';
import { presentDrug } from '../models/present.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import { requireDrug } from '../services/scope.js';
import { usableStockMap } from '../services/stock.js';
import { forecastDrug } from '../services/forecast.js';
import { config } from '../config.js';

const router = Router();

const query = z.object({ leadTimeWeeks: z.coerce.number().int().min(1).max(8).default(config.forecast.defaultLeadTimeWeeks) });

async function stockOf(drugId) {
  const batches = await Batch.find({ drugId }).lean();
  return usableStockMap(batches).get(String(drugId)) || 0;
}

// Overview: suggested reorder for every drug (used to sort / flag the drug chips).
router.get('/', validate(query, 'query'), asyncHandler(async (req, res) => {
  const drugs = await Drug.find({ userId: { $in: req.userIds } }).sort({ name: 1 }).lean();
  const forecasts = [];
  for (const d of drugs) {
    const f = await forecastDrug(d, await stockOf(d._id), req.query.leadTimeWeeks);
    forecasts.push({ drug: presentDrug(d), stock: f.stock, projectedWeekly: f.projectedWeekly, suggestedReorder: f.suggestedReorder });
  }
  res.json({ leadTimeWeeks: req.query.leadTimeWeeks, forecasts });
}));

// Forecast for one drug: weekly sales chart data, moving average, smoothing trend, projection and reorder quantity.
router.get('/:drugId', validate(query, 'query'), asyncHandler(async (req, res) => {
  const drug = await requireDrug(req.userIds, req.params.drugId);
  const forecast = await forecastDrug(drug, await stockOf(drug._id), req.query.leadTimeWeeks);
  res.json({ drug: presentDrug(drug), forecast });
}));

export default router;
