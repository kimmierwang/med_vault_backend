import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Batch, Drug, Supplier, DRUG_CATEGORIES } from '../models/index.js';
import { presentBatch, presentDrug, presentSupplier } from '../models/present.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler, escapeRegex, toObjectId } from '../utils/http.js';
import { dateToISO, daysBetween, isValidISO, isoToDate, todayISO } from '../utils/dates.js';
import { TIER_RANK, getTier } from '../utils/tiers.js';
import { requireBatch, requireDrug, requireSupplier } from '../services/scope.js';
import { logActivity } from '../services/activity.js';
import { reconcile } from '../services/alerts.js';

const router = Router();

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');
const isoDate = z.string().refine(isValidISO, 'Use a valid date as YYYY-MM-DD');

// One line of a delivery. The drug is either an existing one (drugId, e.g. found by scanning) or
// a brand-new one (newDrug); same for the supplier.
const entrySchema = z.object({
  drugId: objectId.optional(),
  newDrug: z.object({
    name: z.string().trim().min(1),
    category: z.enum(DRUG_CATEGORIES).default('Other'),
    barcode: z.string().trim().default(''),
    reorderLevel: z.coerce.number().int().min(1, 'Set a reorder level'),
  }).optional(),
  supplierId: objectId.optional(),
  newSupplierName: z.string().trim().min(1).optional(),
  batchNumber: z.string().trim().min(1, 'Enter the batch number'),
  quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1'),
  expiryDate: isoDate,
  dateReceived: isoDate.optional(),
}).refine((e) => !!e.drugId !== !!e.newDrug, { message: 'Provide either drugId or newDrug' })
  .refine((e) => !!e.supplierId !== !!e.newSupplierName, { message: 'Provide either supplierId or newSupplierName' });

const deliverySchema = z.object({ batches: z.array(entrySchema).min(1).max(200) });

const updateSchema = z.object({
  supplierId: objectId.optional(),
  batchNumber: z.string().trim().min(1).optional(),
  quantity: z.coerce.number().int().min(0).optional(),
  expiryDate: isoDate.optional(),
  dateReceived: isoDate.optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const listQuery = z.object({
  drugId: objectId.optional(),
  status: z.enum(['active', 'all']).default('active'),
  q: z.string().trim().optional(),
});

// Batches with drug / supplier names and their expiry tier, most urgent first
// (the inventory view surfaces higher-urgency tiers at the top, §3.4.3.2).
router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { drugId, status, q } = req.query;
  const drugQuery = { userId: { $in: req.userIds } };
  if (drugId) drugQuery._id = toObjectId(drugId, 'drugId');
  const drugs = await Drug.find(drugQuery).lean();
  const drugById = new Map(drugs.map((d) => [String(d._id), d]));
  const batchQuery = { drugId: { $in: drugs.map((d) => d._id) } };
  if (status === 'active') batchQuery.quantity = { $gt: 0 };
  const [batches, suppliers] = await Promise.all([
    Batch.find(batchQuery).lean(),
    Supplier.find({ userId: { $in: req.userIds } }).lean(),
  ]);
  const supplierById = new Map(suppliers.map((s) => [String(s._id), s]));
  const today = todayISO();
  const needle = q?.toLowerCase();

  const rows = batches
    .map((b) => {
      const drug = drugById.get(String(b.drugId));
      const days = daysBetween(today, dateToISO(b.expiryDate));
      const supplier = supplierById.get(String(b.supplierId));
      return {
        ...presentBatch(b),
        days,
        tier: getTier(days),
        drug: { drugId: String(drug._id), name: drug.name, category: drug.category },
        supplier: supplier ? { supplierId: String(supplier._id), name: supplier.name } : null,
      };
    })
    .filter((b) => !needle || b.drug.name.toLowerCase().includes(needle) || b.batchNumber.toLowerCase().includes(needle))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.days - b.days);

  res.json({ batches: rows });
}));

router.get('/:batchId', asyncHandler(async (req, res) => {
  const { batch } = await requireBatch(req.userIds, req.params.batchId);
  res.json({ batch: presentBatch(batch) });
}));

// Save a whole delivery in one request (bulk stock entry, §4.1.2). Everything is validated first,
// so a delivery is either saved completely or rejected with a message.
router.post('/', validate(deliverySchema), asyncHandler(async (req, res) => {
  const { batches: entries } = req.body;
  const today = todayISO();

  // Drugs
  const existingIds = [...new Set(entries.filter((e) => e.drugId).map((e) => e.drugId))];
  const existingDrugs = new Map();
  for (const id of existingIds) existingDrugs.set(id, await requireDrug(req.userIds, id));

  const newDrugPlans = new Map(); // key -> spec
  for (const e of entries) {
    if (!e.newDrug) continue;
    const key = (e.newDrug.barcode || e.newDrug.name).toLowerCase();
    if (!newDrugPlans.has(key)) newDrugPlans.set(key, e.newDrug);
    if (e.newDrug.barcode) {
      const taken = await Drug.findOne({ userId: { $in: req.userIds }, barcode: e.newDrug.barcode }).lean();
      if (taken) throw new HttpError(409, `Barcode ${e.newDrug.barcode} already belongs to ${taken.name}. Use drugId ${taken._id} instead.`);
    }
  }

  // Suppliers
  const supplierPlans = new Map(); // lower-case name -> existing doc | null
  for (const e of entries) {
    if (e.supplierId) await requireSupplier(req.userIds, e.supplierId);
    if (e.newSupplierName) {
      const key = e.newSupplierName.toLowerCase();
      if (!supplierPlans.has(key)) {
        const found = await Supplier.findOne({ userId: { $in: req.userIds }, name: { $regex: `^${escapeRegex(e.newSupplierName)}$`, $options: 'i' } }).lean();
        supplierPlans.set(key, found || null);
      }
    }
  }

  // Batch rules: not already expired, batch number unique per drug
  const taken = new Set();
  const stocked = existingIds.length ? await Batch.find({ drugId: { $in: existingIds.map((i) => toObjectId(i)) }, quantity: { $gt: 0 } }, 'drugId batchNumber').lean() : [];
  stocked.forEach((b) => taken.add(`${b.drugId}|${b.batchNumber.toLowerCase()}`));
  const problems = [];
  entries.forEach((e, i) => {
    if (e.expiryDate < today) problems.push({ field: `batches.${i}.expiryDate`, message: 'This batch has already expired' });
    const drugKey = e.drugId || `new:${(e.newDrug.barcode || e.newDrug.name).toLowerCase()}`;
    const k = `${drugKey}|${e.batchNumber.toLowerCase()}`;
    if (taken.has(k)) problems.push({ field: `batches.${i}.batchNumber`, message: 'This batch number is already recorded for this drug' });
    taken.add(k);
  });
  if (problems.length) throw new HttpError(400, 'Validation failed', problems);

  // Write
  const createdDrugs = new Map();
  for (const [key, spec] of newDrugPlans) createdDrugs.set(key, await Drug.create({ ...spec, userId: req.user._id }));
  const createdSuppliers = new Map();
  for (const [key, found] of supplierPlans) {
    if (!found) createdSuppliers.set(key, await Supplier.create({ name: entries.find((e) => e.newSupplierName?.toLowerCase() === key).newSupplierName, userId: req.user._id }));
  }

  const docs = entries.map((e) => {
    const drug = e.drugId ? existingDrugs.get(e.drugId) : createdDrugs.get((e.newDrug.barcode || e.newDrug.name).toLowerCase());
    const sKey = e.newSupplierName?.toLowerCase();
    const supplierId = e.supplierId ? toObjectId(e.supplierId) : (supplierPlans.get(sKey) || createdSuppliers.get(sKey))._id;
    return {
      drugId: drug._id,
      supplierId,
      batchNumber: e.batchNumber,
      quantity: e.quantity,
      expiryDate: isoToDate(e.expiryDate),
      dateReceived: isoToDate(e.dateReceived || today),
    };
  });
  const saved = await Batch.insertMany(docs);
  await reconcile(req.userIds);
  for (let i = 0; i < saved.length; i += 1) {
    const drug = entries[i].drugId ? existingDrugs.get(entries[i].drugId) : createdDrugs.get((entries[i].newDrug.barcode || entries[i].newDrug.name).toLowerCase());
    await logActivity({ user: req.user, type: 'stock', message: `Added batch ${saved[i].batchNumber} (${saved[i].quantity} × ${drug.name})` });
  }

  res.status(201).json({
    batches: saved.map(presentBatch),
    createdDrugs: [...createdDrugs.values()].map((d) => presentDrug(d.toObject())),
    createdSuppliers: [...createdSuppliers.values()].map((s) => presentSupplier(s.toObject())),
  });
}));

// Correct a batch (batch number, quantity, expiry date, supplier). Alerts follow automatically.
router.patch('/:batchId', validate(updateSchema), asyncHandler(async (req, res) => {
  const { batch } = await requireBatch(req.userIds, req.params.batchId);
  const patch = { ...req.body };
  if (patch.supplierId) { await requireSupplier(req.userIds, patch.supplierId); patch.supplierId = toObjectId(patch.supplierId); }
  if (patch.expiryDate) patch.expiryDate = isoToDate(patch.expiryDate);
  if (patch.dateReceived) patch.dateReceived = isoToDate(patch.dateReceived);
  if (patch.batchNumber) {
    const clash = await Batch.findOne({ _id: { $ne: batch._id }, drugId: batch.drugId, quantity: { $gt: 0 }, batchNumber: { $regex: `^${escapeRegex(patch.batchNumber)}$`, $options: 'i' } }).lean();
    if (clash) throw new HttpError(409, 'Another batch of this drug already has this number');
  }
  const updated = await Batch.findByIdAndUpdate(batch._id, { $set: patch }, { new: true, runValidators: true }).lean();
  await reconcile(req.userIds);
  res.json({ batch: presentBatch(updated) });
}));

// Discard a batch (e.g. expired stock): removes it from stock and resolves its alert.
router.post('/:batchId/discard', asyncHandler(async (req, res) => {
  const { batch, drug } = await requireBatch(req.userIds, req.params.batchId);
  const updated = await Batch.findByIdAndUpdate(batch._id, { $set: { quantity: 0 } }, { new: true }).lean();
  await reconcile(req.userIds);
  await logActivity({ user: req.user, type: 'alert', message: `Discarded batch ${batch.batchNumber} (${drug.name})` });
  res.json({ batch: presentBatch(updated), discardedQuantity: batch.quantity });
}));

export default router;
