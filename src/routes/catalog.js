import { Router } from 'express';
import { Batch, Drug, DrugCatalog } from '../models/index.js';
import { presentCatalog, presentDrug } from '../models/present.js';
import { HttpError, asyncHandler } from '../utils/http.js';
import { usableStockMap } from '../services/stock.js';

const router = Router();

// Scan a barcode -> the drug's printed details (shared catalog) plus the pharmacy's own record of it, if it has one.
// `details` is null for a drug that is only in the pharmacy's list; 404 only when neither knows the code.
router.get('/barcode/:code', asyncHandler(async (req, res) => {
  const code = req.params.code.trim();
  const [details, own] = await Promise.all([
    DrugCatalog.findOne({ barcode: code }).lean(),
    Drug.findOne({ userId: { $in: req.userIds }, barcode: code }).lean(),
  ]);
  if (!details && !own) throw new HttpError(404, 'No drug with this barcode');
  let drug = null;
  if (own) {
    const batches = await Batch.find({ drugId: own._id }).lean();
    const units = usableStockMap(batches).get(String(own._id)) || 0;
    drug = { ...presentDrug(own), stock: units, lowStock: units < own.reorderLevel };
  }
  res.json({ details: details ? presentCatalog(details) : null, drug });
}));

export default router;
