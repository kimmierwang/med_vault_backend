import { Batch, Drug, Supplier } from '../models/index.js';
import { HttpError, toObjectId } from '../utils/http.js';

// Look-ups that also enforce ownership: a record outside the caller's scope is reported as 404.

export async function requireDrug(userIds, drugId) {
  const drug = await Drug.findOne({ _id: toObjectId(drugId, 'drugId'), userId: { $in: userIds } }).lean();
  if (!drug) throw new HttpError(404, 'Drug not found');
  return drug;
}

export async function requireBatch(userIds, batchId) {
  const batch = await Batch.findById(toObjectId(batchId, 'batchId')).lean();
  if (!batch) throw new HttpError(404, 'Batch not found');
  const drug = await Drug.findOne({ _id: batch.drugId, userId: { $in: userIds } }).lean();
  if (!drug) throw new HttpError(404, 'Batch not found');
  return { batch, drug };
}

export async function requireSupplier(userIds, supplierId) {
  const supplier = await Supplier.findOne({ _id: toObjectId(supplierId, 'supplierId'), userId: { $in: userIds } }).lean();
  if (!supplier) throw new HttpError(404, 'Supplier not found');
  return supplier;
}
