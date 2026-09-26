import { config } from '../config.js';

// Batch dates (expiry, received) are calendar dates: stored as UTC-midnight Dates and exchanged
// as "YYYY-MM-DD". "Today" is the calendar date in the pharmacy's time zone (APP_TIMEZONE).

const dayFormatter = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

export const isoToDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
export const dateToISO = (date) => date.toISOString().slice(0, 10);

// Calendar date (in the pharmacy's zone) of an instant.
export const instantToLocalISO = (instant) => dayFormatter().format(instant);
export const todayISO = (now = new Date()) => instantToLocalISO(now);
export const todayDate = () => isoToDate(todayISO());

export function daysBetween(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export const daysUntil = (date) => daysBetween(todayISO(), dateToISO(date));

export function addDays(iso, n) {
  const d = isoToDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return dateToISO(d);
}

export function isValidISO(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return false;
  const d = isoToDate(str);
  return !Number.isNaN(d.getTime()) && dateToISO(d) === str;
}

// Offset (ms) of the pharmacy's zone from UTC at a given instant.
function zoneOffsetMs(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// [start, end) instants of a local calendar day.
export function localDayRange(iso) {
  const utcMidnight = isoToDate(iso).getTime();
  const start = new Date(utcMidnight - zoneOffsetMs(new Date(utcMidnight)));
  const end = new Date(isoToDate(addDays(iso, 1)).getTime() - zoneOffsetMs(new Date(utcMidnight + 86400000)));
  return { start, end };
}
