import { Batch } from '../models/index.js';
import { dateToISO, todayDate, todayISO } from '../utils/dates.js';

// Sellable = has stock and has not expired. Expired batches never count towards stock or sales.
export const isSellable = (batch, today = todayISO()) => batch.quantity > 0 && dateToISO(batch.expiryDate) >= today;

// Map of drugId (string) -> units that can actually be sold.
export function usableStockMap(batches) {
  const today = todayISO();
  const map = new Map();
  batches.forEach((b) => {
    if (!isSellable(b, today)) return;
    const key = String(b.drugId);
    map.set(key, (map.get(key) || 0) + b.quantity);
  });
  return map;
}

// Sellable batches of a drug, First-Expired-First-Out.
export function fefoBatches(drugId) {
  return Batch.find({ drugId, quantity: { $gt: 0 }, expiryDate: { $gte: todayDate() } })
    .sort({ expiryDate: 1, dateReceived: 1 })
    .lean();
}

// Which batches a sale of `quantity` would come from. Returns null if there is not enough stock.
export function allocateFefo(batches, quantity) {
  let remaining = quantity;
  const picks = [];
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.quantity, remaining);
    picks.push({ batchId: b._id, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: take });
    remaining -= take;
  }
  return remaining > 0 ? null : picks;
}
