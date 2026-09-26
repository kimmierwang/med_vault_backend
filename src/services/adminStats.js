import { Alert, Batch, Drug, Sale } from '../models/index.js';
import { config } from '../config.js';
import { dateToISO, daysBetween, instantToLocalISO, todayISO } from '../utils/dates.js';
import { usableStockMap } from './stock.js';

// Numbers for the admin console. Everything is derived from the same records the pharmacist app uses
// (stored Alerts, batches, sales) with the same rules (tiers, usable stock, rolling 7-day weeks).
//
// Scale note: these load the drugs / batches / recent sales / open alerts of the requested accounts and total them
// in memory. That is fine for hundreds of pharmacies; beyond that, replace `loadFootprint` with Mongo aggregation
// pipelines (same output shape).

export const WEEKS = config.forecast.historyWeeks;
export const weekLabels = () => Array.from({ length: WEEKS }, (_, i) => (i === WEEKS - 1 ? 'This wk' : `${WEEKS - 1 - i}w ago`));

// Everything the given accounts own that the admin numbers need.
export async function loadFootprint(userIds) {
  if (!userIds.length) return { drugs: [], batches: [], sales: [], alerts: [] };
  const drugs = await Drug.find({ userId: { $in: userIds } }).lean();
  const drugIds = drugs.map((d) => d._id);
  const batches = drugIds.length ? await Batch.find({ drugId: { $in: drugIds } }).lean() : [];
  const batchIds = batches.map((b) => b._id);
  const since = new Date(Date.now() - (WEEKS * 7 + 2) * 86400000);
  const [sales, alerts] = await Promise.all([
    batchIds.length ? Sale.find({ batchId: { $in: batchIds }, dateSold: { $gte: since } }, 'batchId quantitySold dateSold').lean() : [],
    drugIds.length ? Alert.find({ status: 'Open', $or: [{ batchId: { $in: batchIds } }, { drugId: { $in: drugIds } }] }).lean() : [],
  ]);
  return { drugs, batches, sales, alerts };
}

const emptySummary = () => ({
  drugs: 0, batches: 0, units: 0, soldThisWeek: 0, weekly: Array(WEEKS).fill(0),
  openAlerts: 0, expired: 0, critical: 0, lowStock: 0, attention: 0,
});

// Map(userId -> summary) for the accounts in `userIds`.
export function summarize(userIds, fp) {
  const out = new Map(userIds.map((id) => [String(id), emptySummary()]));
  const drugOwner = new Map(fp.drugs.map((d) => [String(d._id), String(d.userId)]));
  const batchOwner = new Map(fp.batches.map((b) => [String(b._id), drugOwner.get(String(b.drugId))]));

  fp.drugs.forEach((d) => { const s = out.get(String(d.userId)); if (s) s.drugs += 1; });
  fp.batches.forEach((b) => { const s = out.get(batchOwner.get(String(b._id))); if (s && b.quantity > 0) s.batches += 1; });

  usableStockMap(fp.batches).forEach((units, drugId) => { const s = out.get(drugOwner.get(drugId)); if (s) s.units += units; });

  const today = todayISO();
  fp.sales.forEach((sale) => {
    const s = out.get(batchOwner.get(String(sale.batchId)));
    if (!s) return;
    const age = daysBetween(instantToLocalISO(sale.dateSold), today);
    if (age < 0) return;
    const idx = Math.floor(age / 7);
    if (idx < WEEKS) s.weekly[WEEKS - 1 - idx] += sale.quantitySold;
  });
  out.forEach((s) => { s.soldThisWeek = s.weekly[WEEKS - 1]; });

  fp.alerts.forEach((a) => {
    const owner = a.batchId ? batchOwner.get(String(a.batchId)) : drugOwner.get(String(a.drugId));
    const s = out.get(owner);
    if (!s) return;
    s.openAlerts += 1;
    if (a.alertType === 'low_stock') s.lowStock += 1;
    if (a.alertType === 'expiry' && a.alertTier === 'expired') s.expired += 1;
    if (a.alertType === 'expiry' && a.alertTier === 'critical') s.critical += 1;
    // "needs attention" = everything except the early 90-day heads-up
    if (!(a.alertType === 'expiry' && a.alertTier === 'upcoming')) s.attention += 1;
  });
  return out;
}

export const sumWeekly = (summaries) => {
  const series = Array(WEEKS).fill(0);
  summaries.forEach((s) => s.weekly.forEach((v, i) => { series[i] += v; }));
  return series;
};

// Most urgent stock problems first.
export const severity = (s) => s.expired * 3 + s.critical * 2 + s.attention;

// Stock health of one pharmacy, drug by drug. status = the worst open alert on the drug, else 'ok'.
export function drugHealth(userId, fp) {
  const stock = usableStockMap(fp.batches);
  const today = todayISO();
  const drugs = fp.drugs.filter((d) => String(d.userId) === String(userId));
  const drugOfBatch = new Map(fp.batches.map((b) => [String(b._id), String(b.drugId)]));

  return drugs.map((d) => {
    const own = fp.batches.filter((b) => String(b.drugId) === String(d._id));
    const usable = own.filter((b) => b.quantity > 0 && dateToISO(b.expiryDate) >= today);
    const nearest = usable.length ? Math.min(...usable.map((b) => daysBetween(today, dateToISO(b.expiryDate)))) : null;

    const tiers = fp.alerts
      .filter((a) => (a.batchId ? drugOfBatch.get(String(a.batchId)) === String(d._id) : String(a.drugId) === String(d._id)))
      .map((a) => (a.alertType === 'low_stock' ? 'low' : a.alertTier));
    const order = ['expired', 'critical', 'low', 'warning', 'upcoming'];
    const status = order.find((t) => tiers.includes(t)) || 'ok';

    return { drugId: String(d._id), name: d.name, category: d.category, reorderLevel: d.reorderLevel, stock: stock.get(String(d._id)) || 0, nearestExpiryDays: nearest, status };
  }).sort((a, b) => (a.status === 'ok' ? 9 : ['expired', 'critical', 'low', 'warning', 'upcoming'].indexOf(a.status))
    - (b.status === 'ok' ? 9 : ['expired', 'critical', 'low', 'warning', 'upcoming'].indexOf(b.status)));
}
