import { Batch, Drug, Sale } from '../models/index.js';
import { presentSale } from '../models/present.js';
import { HttpError } from '../utils/http.js';
import { requireDrug } from './scope.js';
import { allocateFefo, fefoBatches } from './stock.js';
import { reconcile } from './alerts.js';
import { instantToLocalISO } from '../utils/dates.js';

// Records a sale: picks the batches closest to expiry first (FEFO), deducts stock and writes one
// Sale row per batch used (ERD: Sale -> BatchID). MongoDB transactions need a replica set, so each
// deduction is a guarded atomic update and is undone if stock changed under us.
export async function recordSale(userIds, drugId, quantity) {
  const drug = await requireDrug(userIds, drugId);
  const batches = await fefoBatches(drug._id);
  const picks = allocateFefo(batches, quantity);
  if (!picks) {
    const available = batches.reduce((s, b) => s + b.quantity, 0);
    throw new HttpError(409, 'Not enough sellable stock for that quantity', { available });
  }

  const done = [];
  for (const p of picks) {
    const res = await Batch.updateOne({ _id: p.batchId, quantity: { $gte: p.quantity } }, { $inc: { quantity: -p.quantity } });
    if (res.modifiedCount !== 1) {
      for (const d of done) await Batch.updateOne({ _id: d.batchId }, { $inc: { quantity: d.quantity } });
      throw new HttpError(409, 'Stock changed while recording the sale, please try again');
    }
    done.push(p);
  }

  const soldAt = new Date();
  const sales = await Sale.insertMany(picks.map((p) => ({ batchId: p.batchId, quantitySold: p.quantity, dateSold: soldAt })));
  await reconcile(userIds);
  return { drug, picks, sales };
}

// Sales in [from, to) for the caller's drugs. Rows are ERD-shaped; `groups` joins the rows of one
// sale (same drug, same moment) for display.
export async function listSales(userIds, { from, to, drugId } = {}) {
  const drugQuery = { userId: { $in: userIds } };
  if (drugId) drugQuery._id = drugId;
  const drugs = await Drug.find(drugQuery).lean();
  if (!drugs.length) return { sales: [], groups: [] };
  const batches = await Batch.find({ drugId: { $in: drugs.map((d) => d._id) } }).lean();
  const batchById = new Map(batches.map((b) => [String(b._id), b]));
  const drugById = new Map(drugs.map((d) => [String(d._id), d]));

  const query = { batchId: { $in: batches.map((b) => b._id) } };
  if (from || to) query.dateSold = { ...(from && { $gte: from }), ...(to && { $lt: to }) };
  const rows = await Sale.find(query).sort({ dateSold: -1 }).lean();

  const sales = rows.map((s) => {
    const batch = batchById.get(String(s.batchId));
    const drug = drugById.get(String(batch.drugId));
    return { ...presentSale(s), drugId: String(drug._id), drugName: drug.name, batchNumber: batch.batchNumber };
  });

  const groups = new Map();
  sales.forEach((s) => {
    const key = `${s.drugId}|${s.dateSold}`;
    if (!groups.has(key)) groups.set(key, { drugId: s.drugId, drugName: s.drugName, dateSold: s.dateSold, date: instantToLocalISO(new Date(s.dateSold)), quantity: 0, batches: [] });
    const g = groups.get(key);
    g.quantity += s.quantitySold;
    g.batches.push({ batchNumber: s.batchNumber, quantity: s.quantitySold });
  });
  return { sales, groups: [...groups.values()] };
}
