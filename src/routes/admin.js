import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { ActivityLog, User } from '../models/index.js';
import { presentActivity, presentAdmin, presentAdminUser } from '../models/present.js';
import { requireAdmin, signAdminToken } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler, escapeRegex, toObjectId } from '../utils/http.js';
import { todayISO } from '../utils/dates.js';
import { listAlertViews } from '../services/alerts.js';
import { deleteUserCascade, reactivateUser, resetUserPassword, setAdminPassword, suspendUser } from '../services/admin.js';
import { drugHealth, loadFootprint, severity, summarize, sumWeekly, weekLabels } from '../services/adminStats.js';
import { buildUsersCsv } from '../services/csv.js';

// The administrator's API. Every route here needs the admin token; pharmacy accounts get 403.
const router = Router();
router.use(requireAdmin);

const DAY = 86400000;
const page = z.coerce.number().int().min(1).default(1);
const limit = (max, def) => z.coerce.number().int().min(1).max(max).default(def);
const MONGO_ID = z.string().refine((v) => /^[a-f\d]{24}$/i.test(v), 'Invalid id');

async function requireUser(userId) {
  const user = await User.findById(toObjectId(userId, 'userId')).lean();
  if (!user) throw new HttpError(404, 'User not found');
  return user;
}

const listItem = (u, s) => {
  const seen = u.lastActiveAt || u.createdAt;
  return {
    ...presentAdminUser(u),
    counts: { drugs: s.drugs, batches: s.batches, units: s.units, soldThisWeek: s.soldThisWeek, openAlerts: s.openAlerts, attention: s.attention, expired: s.expired, critical: s.critical, lowStock: s.lowStock },
    flags: {
      isNew: u.createdAt >= new Date(Date.now() - config.newUserDays * DAY),
      isInactive: u.status === 'active' && seen < new Date(Date.now() - config.inactiveDays * DAY),
    },
  };
};

// ---- Admin profile ----------------------------------------------------------------------------

router.get('/me', asyncHandler(async (req, res) => {
  res.json({ admin: presentAdmin(req.admin), managing: await User.countDocuments() });
}));

const changePasswordSchema = z.object({ currentPassword: z.string().min(1, 'Enter your current password'), newPassword: z.string().min(1, 'Enter a new password') });

router.post('/change-password', validate(changePasswordSchema), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await bcrypt.compare(currentPassword, req.admin.passwordHash))) throw new HttpError(401, 'Your current password is incorrect');
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password you have not used just now');
  const updated = await setAdminPassword(req.admin, newPassword); // ends every other admin session
  res.json({ token: signAdminToken(updated), admin: presentAdmin(updated) });
}));

// ---- Overview -----------------------------------------------------------------------------------

router.get('/overview', asyncHandler(async (_req, res) => {
  const users = await User.find().lean();
  const ids = users.map((u) => u._id);
  const fp = await loadFootprint(ids);
  const summaries = summarize(ids, fp);
  const all = [...summaries.values()];
  const now = Date.now();
  const series = sumWeekly(all);

  const needs = users
    .map((u) => listItem(u, summaries.get(String(u._id))))
    .filter((u) => u.counts.attention > 0)
    .sort((a, b) => severity(b.counts) - severity(a.counts));

  const recent = await ActivityLog.find().sort({ at: -1 }).limit(5).lean();

  res.json({
    totals: {
      users: users.length,
      active: users.filter((u) => u.status === 'active').length,
      suspended: users.filter((u) => u.status === 'suspended').length,
      newThisWeek: users.filter((u) => u.createdAt >= new Date(now - config.newUserDays * DAY)).length,
      inactive: users.filter((u) => u.status === 'active' && (u.lastActiveAt || u.createdAt) < new Date(now - config.inactiveDays * DAY)).length,
      drugs: all.reduce((s, x) => s + x.drugs, 0),
      batches: all.reduce((s, x) => s + x.batches, 0),
      unitsSoldThisWeek: series[series.length - 1],
      openAlerts: all.reduce((s, x) => s + x.openAlerts, 0),
      attention: all.reduce((s, x) => s + x.attention, 0),
      expired: all.reduce((s, x) => s + x.expired, 0),
    },
    pharmaciesNeedingAttention: needs.length,
    weekly: { labels: weekLabels(), series },
    needsAttention: needs.slice(0, 3),
    recentActivity: recent.map(presentActivity),
    generatedAt: new Date().toISOString(), today: todayISO(),
  });
}));

// ---- Users ---------------------------------------------------------------------------------------

const FILTERS = ['all', 'active', 'suspended', 'new', 'inactive'];
const filterQuery = (f) => {
  const now = Date.now();
  const newCut = new Date(now - config.newUserDays * DAY);
  const idleCut = new Date(now - config.inactiveDays * DAY);
  if (f === 'active') return { status: 'active' };
  if (f === 'suspended') return { status: 'suspended' };
  if (f === 'new') return { createdAt: { $gte: newCut } };
  if (f === 'inactive') return { status: 'active', $or: [{ lastActiveAt: { $lt: idleCut } }, { lastActiveAt: null, createdAt: { $lt: idleCut } }] };
  return {};
};

const listQuery = z.object({
  filter: z.enum(FILTERS).default('all'),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['recent', 'name', 'newest']).default('recent'),
  page,
  limit: limit(100, 20),
});

const SORTS = { recent: { lastActiveAt: -1, createdAt: -1 }, name: { name: 1 }, newest: { createdAt: -1 } };

router.get('/users', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { filter, q, sort, page: pg, limit: lim } = req.query;
  const parts = [filterQuery(filter)];
  if (q) {
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    parts.push({ $or: [{ name: rx }, { pharmacyName: rx }, { email: rx }, { staffId: rx }, { location: rx }] });
  }
  const query = parts.filter((p) => Object.keys(p).length).length > 1 ? { $and: parts.filter((p) => Object.keys(p).length) } : (parts.find((p) => Object.keys(p).length) || {});

  const [total, users, ...chipCounts] = await Promise.all([
    User.countDocuments(query),
    User.find(query).sort(SORTS[sort]).skip((pg - 1) * lim).limit(lim).lean(),
    ...FILTERS.map((f) => User.countDocuments(filterQuery(f))),
  ]);

  const ids = users.map((u) => u._id);
  const summaries = summarize(ids, await loadFootprint(ids));
  res.json({
    users: users.map((u) => listItem(u, summaries.get(String(u._id)))),
    counts: Object.fromEntries(FILTERS.map((f, i) => [f, chipCounts[i]])),
    page: pg, limit: lim, total, pages: Math.max(1, Math.ceil(total / lim)),
  });
}));

// Registered before /users/:userId so "export.csv" is not read as an id.
router.get('/users/export.csv', asyncHandler(async (_req, res) => {
  const users = await User.find().sort({ name: 1 }).lean();
  const ids = users.map((u) => u._id);
  const summaries = summarize(ids, await loadFootprint(ids));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="medvault-users-${todayISO()}.csv"`);
  res.send(buildUsersCsv(users.map((u) => listItem(u, summaries.get(String(u._id))))));
}));

router.get('/users/:userId', asyncHandler(async (req, res) => {
  const user = await requireUser(req.params.userId);
  const fp = await loadFootprint([user._id]);
  const summary = summarize([user._id], fp).get(String(user._id));
  const [alerts, activity] = await Promise.all([
    listAlertViews([user._id], { status: 'Open' }),
    ActivityLog.find({ userId: user._id }).sort({ at: -1 }).limit(5).lean(),
  ]);
  res.json({
    user: listItem(user, summary),
    weekly: { labels: weekLabels(), series: summary.weekly },
    drugs: drugHealth(user._id, fp),
    alerts,
    activity: activity.map(presentActivity),
  });
}));

router.post('/users/:userId/suspend', asyncHandler(async (req, res) => {
  const user = await suspendUser(await requireUser(req.params.userId));
  res.json({ user: presentAdminUser(user) });
}));

router.post('/users/:userId/reactivate', asyncHandler(async (req, res) => {
  const user = await reactivateUser(await requireUser(req.params.userId));
  res.json({ user: presentAdminUser(user) });
}));

// The temporary password is returned ONCE here and is never stored or logged in plain text.
router.post('/users/:userId/reset-password', asyncHandler(async (req, res) => {
  const { user, temporaryPassword } = await resetUserPassword(await requireUser(req.params.userId));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: presentAdminUser(user), temporaryPassword, mustChangePassword: true });
}));

router.delete('/users/:userId', asyncHandler(async (req, res) => {
  const user = await requireUser(req.params.userId);
  await deleteUserCascade(user);
  res.json({ deleted: true, userId: String(user._id) });
}));

// ---- Alerts across every pharmacy ----------------------------------------------------------------------

const alertsQuery = z.object({
  type: z.enum(['expiry', 'low_stock']).optional(),
  tier: z.enum(['upcoming', 'warning', 'critical', 'expired']).optional(),
  q: z.string().trim().max(100).optional(),
  page,
  limit: limit(200, 50),
});

router.get('/alerts', validate(alertsQuery, 'query'), asyncHandler(async (req, res) => {
  const { type, tier, q, page: pg, limit: lim } = req.query;
  const users = await User.find({}, 'name pharmacyName status').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const views = (await listAlertViews(users.map((u) => u._id), { status: 'Open' })).map((a) => {
    const owner = byId.get(a.drug.userId);
    return { ...a, pharmacy: { userId: a.drug.userId, name: owner?.name, pharmacyName: owner?.pharmacyName, status: owner?.status } };
  });

  const needle = q?.toLowerCase();
  const scoped = needle ? views.filter((a) => a.pharmacy.pharmacyName?.toLowerCase().includes(needle) || a.drug.name.toLowerCase().includes(needle)) : views;
  const counts = { all: scoped.length, low_stock: scoped.filter((a) => a.alertType === 'low_stock').length };
  ['expired', 'critical', 'warning', 'upcoming'].forEach((t) => { counts[t] = scoped.filter((a) => a.alertType === 'expiry' && a.alertTier === t).length; });

  const filtered = scoped.filter((a) => (!type || a.alertType === type) && (!tier || (a.alertType === 'expiry' && a.alertTier === tier)));
  res.json({
    alerts: filtered.slice((pg - 1) * lim, pg * lim),
    counts,
    pharmaciesAffected: new Set(scoped.filter((a) => !(a.alertType === 'expiry' && a.alertTier === 'upcoming')).map((a) => a.pharmacy.userId)).size,
    page: pg, limit: lim, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / lim)),
  });
}));

// ---- Activity log ------------------------------------------------------------------------------------------

const GROUPS = { all: null, access: ['login', 'signup'], stock: ['stock', 'alert'], sale: ['sale'], admin: ['admin'] };
const activityQuery = z.object({
  group: z.enum(Object.keys(GROUPS)).default('all'),
  userId: MONGO_ID.optional(),
  page,
  limit: limit(200, 50),
});

router.get('/activity', validate(activityQuery, 'query'), asyncHandler(async (req, res) => {
  const { group, userId, page: pg, limit: lim } = req.query;
  const base = userId ? { userId: toObjectId(userId, 'userId') } : {};
  const withGroup = (g) => (GROUPS[g] ? { ...base, type: { $in: GROUPS[g] } } : base);

  const [total, rows, ...groupCounts] = await Promise.all([
    ActivityLog.countDocuments(withGroup(group)),
    ActivityLog.find(withGroup(group)).sort({ at: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
    ...Object.keys(GROUPS).map((g) => ActivityLog.countDocuments(withGroup(g))),
  ]);
  res.json({
    activity: rows.map(presentActivity),
    counts: Object.fromEntries(Object.keys(GROUPS).map((g, i) => [g, groupCounts[i]])),
    page: pg, limit: lim, total, pages: Math.max(1, Math.ceil(total / lim)),
  });
}));

export default router;
