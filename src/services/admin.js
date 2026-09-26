import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { Admin, Alert, Batch, DeviceToken, Drug, Sale, Supplier, User } from '../models/index.js';
import { HttpError } from '../utils/http.js';
import { logActivity } from './activity.js';

// ---- The single administrator ---------------------------------------------------------------

export function assertStrongAdminPassword(password) {
  const min = config.adminPasswordMinLength;
  if (typeof password !== 'string' || password.length < min) throw new HttpError(400, `The admin password must be at least ${min} characters`);
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, 'The admin password needs upper-case and lower-case letters and a number');
  }
}

// Creates THE administrator. Refuses if one already exists. The database also enforces this
// (unique `singleton` field), so even a race between two callers cannot produce two admins.
export async function createAdmin({ name, email, adminId, password }) {
  assertStrongAdminPassword(password);
  await Admin.init(); // make sure the unique indexes exist before relying on them
  if (await Admin.countDocuments()) throw new HttpError(409, 'An administrator already exists. There can only be one.');
  const emailNorm = String(email || '').trim().toLowerCase();
  const idNorm = String(adminId || '').trim().toUpperCase();
  if (!/^\S+@\S+\.\S+$/.test(emailNorm)) throw new HttpError(400, 'Enter a valid admin email address');
  if (!idNorm) throw new HttpError(400, 'Enter an admin ID');
  // Login checks the admin first, so a pharmacy account using the same email / staff ID would be shadowed.
  const clash = await User.findOne({ $or: [{ email: emailNorm }, { staffId: idNorm }] }).lean();
  if (clash) throw new HttpError(409, 'A pharmacy account already uses that email or staff ID');
  try {
    return await Admin.create({ name: name || config.adminName, email: emailNorm, adminId: idNorm, passwordHash: await bcrypt.hash(password, config.bcryptRounds) });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, 'An administrator already exists. There can only be one.');
    throw err;
  }
}

// Start-up: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD if (and only if) there is none yet.
export async function ensureAdmin() {
  await Admin.init();
  if (await Admin.countDocuments()) return { created: false, exists: true };
  if (!config.adminEmail || !config.adminPassword) return { created: false, exists: false };
  const admin = await createAdmin({ name: config.adminName, email: config.adminEmail, adminId: config.adminId, password: config.adminPassword });
  return { created: true, exists: true, email: admin.email };
}

export async function setAdminPassword(admin, newPassword) {
  assertStrongAdminPassword(newPassword);
  return Admin.findByIdAndUpdate(admin._id, { $set: { passwordHash: await bcrypt.hash(newPassword, config.bcryptRounds) }, $inc: { tokenVersion: 1 } }, { new: true });
}

// ---- Managing pharmacy accounts --------------------------------------------------------------

export async function suspendUser(user) {
  if (user.status === 'suspended') return user;
  // tokenVersion +1 ends every session the user has open right now
  const updated = await User.findByIdAndUpdate(user._id, { $set: { status: 'suspended', suspendedAt: new Date() }, $inc: { tokenVersion: 1 } }, { new: true }).lean();
  await logActivity({ user: updated, actor: 'admin', type: 'admin', message: `Suspended ${updated.pharmacyName}` });
  return updated;
}

export async function reactivateUser(user) {
  if (user.status === 'active') return user;
  const updated = await User.findByIdAndUpdate(user._id, { $set: { status: 'active', suspendedAt: null, lastActiveAt: new Date() } }, { new: true }).lean();
  await logActivity({ user: updated, actor: 'admin', type: 'admin', message: `Reactivated ${updated.pharmacyName}` });
  return updated;
}

const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading
const pick = (n) => Array.from({ length: n }, () => TEMP_CHARS[crypto.randomInt(TEMP_CHARS.length)]).join('');
export const makeTemporaryPassword = () => `MV-${pick(4)}-${pick(4)}`;

// New temporary password: old password stops working, open sessions end, and the user must choose their own on next sign-in.
export async function resetUserPassword(user) {
  const temporaryPassword = makeTemporaryPassword();
  const updated = await User.findByIdAndUpdate(user._id, {
    $set: { passwordHash: await bcrypt.hash(temporaryPassword, config.bcryptRounds), mustChangePassword: true },
    $inc: { tokenVersion: 1 },
  }, { new: true }).lean();
  await logActivity({ user: updated, actor: 'admin', type: 'admin', message: `Reset the password for ${updated.name}` }); // the password itself is never logged
  return { user: updated, temporaryPassword };
}

// Removes an account and everything it owns, without writing to the activity log (used by deleteUserCascade and the seed).
// MongoDB transactions need a replica set, so this is done in dependency order with the account removed LAST: if
// anything fails half-way the account still exists and the delete can simply be repeated.
export async function purgeUserData(user) {
  const drugIds = (await Drug.find({ userId: user._id }, '_id').lean()).map((d) => d._id);
  const batchIds = drugIds.length ? (await Batch.find({ drugId: { $in: drugIds } }, '_id').lean()).map((b) => b._id) : [];
  if (batchIds.length) await Sale.deleteMany({ batchId: { $in: batchIds } });
  if (drugIds.length || batchIds.length) await Alert.deleteMany({ $or: [{ batchId: { $in: batchIds } }, { drugId: { $in: drugIds } }] });
  if (drugIds.length) await Batch.deleteMany({ drugId: { $in: drugIds } });
  await Drug.deleteMany({ userId: user._id });
  await Supplier.deleteMany({ userId: user._id });
  await DeviceToken.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });
}

// Permanently deletes an account (the admin's "Delete account"). The audit entry keeps the name so the trail survives.
export async function deleteUserCascade(user) {
  await purgeUserData(user);
  await logActivity({ user, actor: 'admin', type: 'admin', message: `Deleted the account of ${user.name} (${user.pharmacyName})` });
}
