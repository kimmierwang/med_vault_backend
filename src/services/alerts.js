import { Alert, Batch, Drug } from '../models/index.js';
import { presentAlert, presentBatch, presentDrug } from '../models/present.js';
import { TIER_RANK, getTier } from '../utils/tiers.js';
import { dateToISO, daysBetween, todayISO } from '../utils/dates.js';
import { withLock } from '../utils/mutex.js';
import { usableStockMap } from './stock.js';
import { sendToUsers } from './push.js';

// Alerts are stored records (ERD: Alert). They are opened when a batch or drug turns abnormal,
// moved to a worse tier as the expiry date approaches, and resolved when the problem goes away
// (batch discarded, sold out, expiry corrected, drug restocked). This function is called after
// every change to stock and by the daily job.

const keyOf = (type, batchId, drugId) => (type === 'expiry' ? `expiry:${batchId}` : `low_stock:${drugId}`);

async function loadScope(userIds) {
  const drugs = await Drug.find({ userId: { $in: userIds } }).lean();
  const batches = drugs.length ? await Batch.find({ drugId: { $in: drugs.map((d) => d._id) } }).lean() : [];
  return { drugs, batches };
}

// Everything that is abnormal right now.
export function computeConditions(drugs, batches) {
  const today = todayISO();
  const list = [];
  batches.forEach((b) => {
    if (b.quantity <= 0) return;
    const tier = getTier(daysBetween(today, dateToISO(b.expiryDate)));
    if (tier === 'ok') return;
    list.push({ key: keyOf('expiry', b._id, null), alertType: 'expiry', alertTier: tier, batchId: b._id, drugId: null });
  });
  const stock = usableStockMap(batches);
  drugs.forEach((d) => {
    const units = stock.get(String(d._id)) || 0;
    if (units < d.reorderLevel) {
      list.push({ key: keyOf('low_stock', null, d._id), alertType: 'low_stock', alertTier: units === 0 ? 'critical' : 'warning', batchId: null, drugId: d._id });
    }
  });
  return list;
}

function describe(alert, drug, batch, stock) {
  if (alert.alertType === 'low_stock') return `${drug.name} is low: ${stock} left (reorder level ${drug.reorderLevel})`;
  const days = daysBetween(todayISO(), dateToISO(batch.expiryDate));
  if (alert.alertTier === 'expired') return `${drug.name} batch ${batch.batchNumber} has expired`;
  return `${drug.name} batch ${batch.batchNumber} expires in ${days} day${days === 1 ? '' : 's'} (${alert.alertTier})`;
}

async function doReconcile(userIds) {
  const { drugs, batches } = await loadScope(userIds);
  const conditions = computeConditions(drugs, batches);
  const byKey = new Map(conditions.map((c) => [c.key, c]));

  const open = drugs.length
    ? await Alert.find({ status: 'Open', $or: [{ batchId: { $in: batches.map((b) => b._id) } }, { drugId: { $in: drugs.map((d) => d._id) } }] }).lean()
    : [];

  const seen = new Set();
  const toResolve = [];
  const escalated = [];
  const toRetier = [];
  open.forEach((a) => {
    const k = keyOf(a.alertType, a.batchId, a.drugId);
    const c = byKey.get(k);
    if (!c || seen.has(k)) { toResolve.push(a._id); return; } // problem gone, or a duplicate record
    seen.add(k);
    if (c.alertTier !== a.alertTier) {
      toRetier.push({ id: a._id, tier: c.alertTier });
      if (TIER_RANK[c.alertTier] < TIER_RANK[a.alertTier]) escalated.push({ ...a, alertTier: c.alertTier });
    }
  });
  const toCreate = conditions.filter((c) => !seen.has(c.key));

  const now = new Date();
  if (toResolve.length) await Alert.updateMany({ _id: { $in: toResolve } }, { $set: { status: 'Resolved', resolvedAt: now } });
  for (const r of toRetier) await Alert.updateOne({ _id: r.id }, { $set: { alertTier: r.tier } });
  const created = toCreate.length
    ? await Alert.insertMany(toCreate.map((c) => ({ batchId: c.batchId, drugId: c.drugId, alertType: c.alertType, alertTier: c.alertTier, status: 'Open', createdAt: now, resolvedAt: null })))
    : [];

  // Tell the pharmacist about new alerts and alerts that just got worse.
  const toTell = [...created.map((a) => a.toObject()), ...escalated];
  if (toTell.length) {
    const drugById = new Map(drugs.map((d) => [String(d._id), d]));
    const batchById = new Map(batches.map((b) => [String(b._id), b]));
    const stock = usableStockMap(batches);
    const lines = toTell.map((a) => {
      const batch = a.batchId ? batchById.get(String(a.batchId)) : null;
      const drug = a.drugId ? drugById.get(String(a.drugId)) : drugById.get(String(batch?.drugId));
      return drug ? describe(a, drug, batch, stock.get(String(drug._id)) || 0) : null;
    }).filter(Boolean);
    if (lines.length) {
      await sendToUsers(userIds, {
        title: lines.length === 1 ? 'MedVault alert' : `${lines.length} new MedVault alerts`,
        body: lines.length === 1 ? lines[0] : `${lines[0]} and ${lines.length - 1} more`,
        data: { screen: 'Alerts' },
      });
    }
  }

  return { opened: created.length, escalated: escalated.length, resolved: toResolve.length };
}

export const reconcile = (userIds) => withLock(userIds.map(String).sort().join(','), () => doReconcile(userIds));

// Daily job: expiry tiers change as time passes even when nobody touches the stock.
export async function reconcileAll() {
  const owners = await Drug.distinct('userId');
  for (const owner of owners) await reconcile([owner]);
  return owners.length;
}

// Alerts joined with their drug / batch, ready for the app.
export async function listAlertViews(userIds, { status, type, tier } = {}) {
  const { drugs, batches } = await loadScope(userIds);
  if (!drugs.length) return [];
  const query = { $or: [{ batchId: { $in: batches.map((b) => b._id) } }, { drugId: { $in: drugs.map((d) => d._id) } }] };
  if (status) query.status = status;
  if (type) query.alertType = type;
  if (tier) query.alertTier = tier;
  const alerts = await Alert.find(query).lean();

  const drugById = new Map(drugs.map((d) => [String(d._id), d]));
  const batchById = new Map(batches.map((b) => [String(b._id), b]));
  const stock = usableStockMap(batches);
  const today = todayISO();

  const views = alerts.map((a) => {
    const batch = a.batchId ? batchById.get(String(a.batchId)) : null;
    const drug = a.drugId ? drugById.get(String(a.drugId)) : drugById.get(String(batch?.drugId));
    if (!drug) return null;
    return {
      ...presentAlert(a),
      drug: presentDrug(drug),
      batch: batch ? presentBatch(batch) : null,
      days: batch ? daysBetween(today, dateToISO(batch.expiryDate)) : null,
      stock: a.alertType === 'low_stock' ? stock.get(String(drug._id)) || 0 : null,
    };
  }).filter(Boolean);

  return views.sort((a, b) => {
    if (status === 'Resolved') return a.resolvedAt < b.resolvedAt ? 1 : -1;
    const r = TIER_RANK[a.alertTier] - TIER_RANK[b.alertTier];
    if (r !== 0) return r;
    if (a.alertType !== b.alertType) return a.alertType === 'expiry' ? -1 : 1;
    return (a.days ?? 0) - (b.days ?? 0);
  });
}
