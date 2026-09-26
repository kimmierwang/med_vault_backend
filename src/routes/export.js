import { Router } from 'express';
import { Batch, Drug, Supplier } from '../models/index.js';
import { asyncHandler } from '../utils/http.js';
import { buildInventoryCsv } from '../services/csv.js';
import { todayISO } from '../utils/dates.js';

const router = Router();

// CSV export of current inventory (§3.4.2 non-functional requirement).
router.get('/inventory.csv', asyncHandler(async (req, res) => {
  const [drugs, suppliers] = await Promise.all([
    Drug.find({ userId: { $in: req.userIds } }).lean(),
    Supplier.find({ userId: { $in: req.userIds } }).lean(),
  ]);
  const batches = drugs.length ? await Batch.find({ drugId: { $in: drugs.map((d) => d._id) } }).lean() : [];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="medvault-inventory-${todayISO()}.csv"`);
  res.send(buildInventoryCsv({ drugs, batches, suppliers }));
}));

export default router;
