import { Batch, Sale } from '../models/index.js';
import { config } from '../config.js';
import { daysBetween, instantToLocalISO, todayISO } from '../utils/dates.js';

// Demand forecasting (documentation §3.4.5): weekly aggregation of sales, a moving average and an
// exponential smoothing trend, combined into a projection and a suggested reorder quantity.

export const movingAverage = (series, window = config.forecast.maWindow) => {
  const slice = series.slice(-window);
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
};

export function exponentialSmoothing(series, alpha = config.forecast.alpha) {
  if (!series.length) return 0;
  let level = series[0];
  for (let i = 1; i < series.length; i += 1) level = alpha * series[i] + (1 - alpha) * level;
  return level;
}

// Units sold per rolling 7-day bucket, oldest -> newest (last bucket = the latest 7 days incl. today).
export async function weeklyTotals(drugId, weeks = config.forecast.historyWeeks) {
  const batchIds = (await Batch.find({ drugId }, '_id').lean()).map((b) => b._id);
  const buckets = Array(weeks).fill(0);
  if (!batchIds.length) return buckets;
  const since = new Date(Date.now() - (weeks * 7 + 2) * 86400000);
  const sales = await Sale.find({ batchId: { $in: batchIds }, dateSold: { $gte: since } }, 'quantitySold dateSold').lean();
  const today = todayISO();
  sales.forEach((s) => {
    const age = daysBetween(instantToLocalISO(s.dateSold), today);
    if (age < 0) return;
    const idx = Math.floor(age / 7);
    if (idx < weeks) buckets[weeks - 1 - idx] += s.quantitySold;
  });
  return buckets;
}

// suggested = projected weekly demand x restocking period + reorder level (safety stock) - stock in hand
export async function forecastDrug(drug, stock, leadTimeWeeks = config.forecast.defaultLeadTimeWeeks) {
  const series = await weeklyTotals(drug._id);
  const ma = movingAverage(series);
  const es = exponentialSmoothing(series);
  const weekly = (ma + es) / 2;
  const demandOverPeriod = weekly * leadTimeWeeks;
  const suggested = Math.max(0, Math.ceil(demandOverPeriod + drug.reorderLevel - stock));
  const labels = series.map((_, i) => (i === series.length - 1 ? 'This wk' : `${series.length - 1 - i}w ago`));
  return {
    weeks: series.length, labels, series,
    movingAverage: round(ma), exponentialSmoothing: round(es), projectedWeekly: round(weekly),
    demandOverPeriod: round(demandOverPeriod), leadTimeWeeks, stock, reorderLevel: drug.reorderLevel, suggestedReorder: suggested,
    method: { maWindow: config.forecast.maWindow, alpha: config.forecast.alpha },
  };
}

const round = (n) => Math.round(n * 10) / 10;
