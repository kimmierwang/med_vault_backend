import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler, toObjectId } from '../utils/http.js';
import { addDays, isValidISO, localDayRange, todayISO } from '../utils/dates.js';
import { listSales, recordSale } from '../services/sales.js';
import { presentSale } from '../models/present.js';
import { logActivity } from '../services/activity.js';

const router = Router();

const saleSchema = z.object({
  drugId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid drugId'),
  quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1'),
});

const listQuery = z.object({
  date: z.string().refine(isValidISO, 'Use YYYY-MM-DD').optional(),            // one local day
  days: z.coerce.number().int().min(1).max(365).optional(),                    // or the last N days
  drugId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid drugId').optional(),
});

// Record a sale. Stock is taken from the earliest-expiring batches first (FEFO).
router.post('/', validate(saleSchema), asyncHandler(async (req, res) => {
  const { drug, picks, sales } = await recordSale(req.userIds, req.body.drugId, req.body.quantity);
  await logActivity({ user: req.user, type: 'sale', message: `Recorded a sale of ${req.body.quantity} × ${drug.name}` });
  res.status(201).json({
    drug: { drugId: String(drug._id), name: drug.name },
    quantity: req.body.quantity,
    picks: picks.map((p) => ({ batchId: String(p.batchId), batchNumber: p.batchNumber, quantity: p.quantity })),
    sales: sales.map(presentSale),
  });
}));

router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { date, days = 30, drugId } = req.query;
  let range;
  if (date) range = localDayRange(date);
  else range = { start: localDayRange(addDays(todayISO(), -(days - 1))).start, end: localDayRange(todayISO()).end };
  const result = await listSales(req.userIds, { from: range.start, to: range.end, drugId: drugId && toObjectId(drugId) });
  res.json({ range: { from: range.start.toISOString(), to: range.end.toISOString() }, ...result });
}));

// Today's sales log (the list under "Record sale").
router.get('/today', asyncHandler(async (req, res) => {
  const { start, end } = localDayRange(todayISO());
  const result = await listSales(req.userIds, { from: start, to: end });
  res.json({ totalUnits: result.groups.reduce((s, g) => s + g.quantity, 0), ...result });
}));

export default router;
