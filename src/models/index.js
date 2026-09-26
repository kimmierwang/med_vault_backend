import mongoose from 'mongoose';
import { config } from '../config.js';

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

// The six collections mirror the ERD (Figure 3.4.6.2). Foreign keys are ObjectId references.
// The ERD's "ID" columns are MongoDB's `_id`; the API exposes them as userId, drugId, batchId ...

export const DRUG_CATEGORIES = ['Antibiotic', 'Analgesic', 'Antimalarial', 'Antidiabetic', 'Antihistamine', 'Supplement', 'Other'];
export const ROLES = ['Pharmacist', 'Staff'];
export const USER_STATUSES = ['active', 'suspended'];
export const ACTIVITY_TYPES = ['login', 'signup', 'stock', 'sale', 'alert', 'admin'];

// ---- User -------------------------------------------------------------------
const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ROLES, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  staffId: { type: String, required: true, unique: true, uppercase: true, trim: true },
  passwordHash: { type: String, required: true },
  pharmacyName: { type: String, required: true, trim: true },
  location: { type: String, default: '', trim: true },
  // Managed by the administrator
  status: { type: String, enum: USER_STATUSES, default: 'active', index: true },
  suspendedAt: { type: Date, default: null },
  mustChangePassword: { type: Boolean, default: false },   // set after an admin password reset
  tokenVersion: { type: Number, default: 0 },              // bump to sign the user out everywhere
  lastLoginAt: { type: Date, default: null },
  lastActiveAt: { type: Date, default: Date.now },
}, { timestamps: true });
userSchema.index({ createdAt: -1 });
userSchema.index({ lastActiveAt: -1 });

// ---- Admin: THE single administrator ------------------------------------------------------
// `singleton` is a constant, immutable and unique, so MongoDB itself refuses a second admin document.
// The admin is deliberately not a User: it never appears in user lists, has no pharmacy data, and can't be
// suspended or deleted through the API. It is created only by the server (create-admin script / env vars).
const adminSchema = new Schema({
  singleton: { type: String, default: 'admin', enum: ['admin'], immutable: true, unique: true },
  adminId: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  tokenVersion: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

// ---- ActivityLog: what happens across the system, for the admin's Activity tab -------------
// Name / pharmacy are copied in so entries stay readable after an account is deleted.
const activitySchema = new Schema({
  userId: { type: ObjectId, default: null, index: true },
  userName: { type: String, default: '' },
  pharmacyName: { type: String, default: '' },
  actor: { type: String, enum: ['user', 'admin', 'system'], default: 'user' },
  type: { type: String, enum: ACTIVITY_TYPES, required: true },
  message: { type: String, required: true },
  at: { type: Date, default: Date.now },
});
activitySchema.index({ at: -1 });
activitySchema.index({ type: 1, at: -1 });
// Old entries are removed automatically (ACTIVITY_RETENTION_DAYS).
activitySchema.index({ at: 1 }, { expireAfterSeconds: config.activityRetentionDays * 86400 });

// ---- Supplier (ownership column added so pharmacies never see each other's suppliers) -----
const supplierSchema = new Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  contactInfo: { type: String, default: '', trim: true },
  address: { type: String, default: '', trim: true },
});

// ---- Drug -------------------------------------------------------------------
const drugSchema = new Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, enum: DRUG_CATEGORIES, default: 'Other' },
  barcode: { type: String, default: '', trim: true },
  reorderLevel: { type: Number, min: 0, default: 0 },
});
drugSchema.index({ userId: 1, barcode: 1 });

// ---- Batch ------------------------------------------------------------------
const batchSchema = new Schema({
  drugId: { type: ObjectId, ref: 'Drug', required: true, index: true },
  supplierId: { type: ObjectId, ref: 'Supplier', required: true },
  batchNumber: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 0 },
  expiryDate: { type: Date, required: true },
  dateReceived: { type: Date, required: true },
});
batchSchema.index({ drugId: 1, expiryDate: 1 });

// ---- Sale: one row per batch used (a FEFO sale spanning two batches = two rows) -------
const saleSchema = new Schema({
  batchId: { type: ObjectId, ref: 'Batch', required: true, index: true },
  quantitySold: { type: Number, required: true, min: 1 },
  dateSold: { type: Date, required: true, default: Date.now },
});

// ---- Alert: expiry alerts point to a batch, low-stock alerts to a drug ---------------
const alertSchema = new Schema({
  batchId: { type: ObjectId, ref: 'Batch', default: null },
  drugId: { type: ObjectId, ref: 'Drug', default: null },
  alertType: { type: String, enum: ['expiry', 'low_stock'], required: true },
  alertTier: { type: String, enum: ['upcoming', 'warning', 'critical', 'expired'], required: true },
  status: { type: String, enum: ['Open', 'Resolved'], default: 'Open' },
  createdAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null },
});
alertSchema.index({ status: 1, batchId: 1 });
alertSchema.index({ status: 1, drugId: 1 });

// ---- DeviceToken: Expo push tokens (infrastructure, not part of the ERD) --------------
const deviceTokenSchema = new Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  token: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: true },
}, { timestamps: true });

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

export const User = model('User', userSchema);
export const Admin = model('Admin', adminSchema);
export const ActivityLog = model('ActivityLog', activitySchema);
export const Supplier = model('Supplier', supplierSchema);
export const Drug = model('Drug', drugSchema);
export const Batch = model('Batch', batchSchema);
export const Sale = model('Sale', saleSchema);
export const Alert = model('Alert', alertSchema);
export const DeviceToken = model('DeviceToken', deviceTokenSchema);
