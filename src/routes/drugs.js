import { Router } from 'express';
import { z } from 'zod';
import { Batch, Drug, DRUG_CATEGORIES } from '../models/index.js';
import { presentDrug } from '../models/present.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler, escapeRegex } from '../utils/http.js';
import { requireDrug } from '../services/scope.js';
import { usableStockMap } from '../services/stock.js';
import { reconcile } from '../services/alerts.js';

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter the drug name'),
  category: z.enum(DRUG_CATEGORIES).default('Other'),
  barcode: z.string().trim().default(''),
  reorderLevel: z.coerce.number().int().min(0).default(0),
});
const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const listQuery = z.object({ q: z.string().trim().optional() });

async function withStock(userIds, drugs) {
  const batches = drugs.length ? await Batch.find({ drugId: { $in: drugs.map((d) => d._id) } }).lean() : [];
  const stock = usableStockMap(batches);
  return drugs.map((d) => {
    const units = stock.get(String(d._id)) || 0;
    return { ...presentDrug(d), stock: units, lowStock: units < d.reorderLevel };
  });
}

const barcodeTaken = async (userIds, barcode, exceptId) => {
  if (!barcode) return null;
  const query = { userId: { $in: userIds }, barcode };
  if (exceptId) query._id = { $ne: exceptId };
  return Drug.findOne(query).lean();
};

router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const query = { userId: { $in: req.userIds } };
  if (req.query.q) query.name = { $regex: escapeRegex(req.query.q), $options: 'i' };
  const drugs = await Drug.find(query).sort({ name: 1 }).lean();
  res.json({ drugs: await withStock(req.userIds, drugs) });
}));

// Scan lookup: the app scans a barcode and gets the drug to auto-fill the form. 404 = new drug.
router.get('/barcode/:code', asyncHandler(async (req, res) => {
  const drug = await Drug.findOne({ userId: { $in: req.userIds }, barcode: req.params.code.trim() }).lean();
  if (!drug) throw new HttpError(404, 'No drug with this barcode');
  res.json({ drug: (await withStock(req.userIds, [drug]))[0] });
}));

router.get('/:drugId', asyncHandler(async (req, res) => {
  const drug = await requireDrug(req.userIds, req.params.drugId);
  res.json({ drug: (await withStock(req.userIds, [drug]))[0] });
}));

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const existing = await barcodeTaken(req.userIds, req.body.barcode);
  if (existing) throw new HttpError(409, `Barcode already belongs to ${existing.name}`);
  const drug = await Drug.create({ ...req.body, userId: req.user._id });
  await reconcile(req.userIds);
  res.status(201).json({ drug: (await withStock(req.userIds, [drug.toObject()]))[0] });
}));

// Update a drug, including its reorder level (the pharmacist-defined low-stock threshold).
router.patch('/:drugId', validate(updateSchema), asyncHandler(async (req, res) => {
  const drug = await requireDrug(req.userIds, req.params.drugId);
  if (req.body.barcode) {
    const existing = await barcodeTaken(req.userIds, req.body.barcode, drug._id);
    if (existing) throw new HttpError(409, `Barcode already belongs to ${existing.name}`);
  }
  const updated = await Drug.findByIdAndUpdate(drug._id, { $set: req.body }, { new: true, runValidators: true }).lean();
  await reconcile(req.userIds);
  res.json({ drug: (await withStock(req.userIds, [updated]))[0] });
}));

export default router;
