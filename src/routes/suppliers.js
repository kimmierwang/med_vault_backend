import { Router } from 'express';
import { z } from 'zod';
import { Supplier } from '../models/index.js';
import { presentSupplier } from '../models/present.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, escapeRegex } from '../utils/http.js';

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter the supplier name'),
  contactInfo: z.string().trim().default(''),
  address: z.string().trim().default(''),
});

router.get('/', asyncHandler(async (req, res) => {
  const suppliers = await Supplier.find({ userId: { $in: req.userIds } }).sort({ name: 1 }).lean();
  res.json({ suppliers: suppliers.map(presentSupplier) });
}));

// Creating a supplier that already exists (same name) returns the existing one.
router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const existing = await Supplier.findOne({ userId: { $in: req.userIds }, name: { $regex: `^${escapeRegex(req.body.name)}$`, $options: 'i' } }).lean();
  if (existing) return res.json({ supplier: presentSupplier(existing) });
  const supplier = await Supplier.create({ ...req.body, userId: req.user._id });
  return res.status(201).json({ supplier: presentSupplier(supplier) });
}));

export default router;
