import { dateToISO } from '../utils/dates.js';

// Turns database documents (lean or not) into the JSON the app receives. Field names follow the ERD.
const id = (v) => (v == null ? null : String(v));

export const presentUser = (u) => ({
  userId: id(u._id), name: u.name, role: u.role, email: u.email, staffId: u.staffId, pharmacyName: u.pharmacyName,
  location: u.location || '', status: u.status || 'active', mustChangePassword: !!u.mustChangePassword,
});

// What the administrator sees of a pharmacy account.
export const presentAdminUser = (u) => ({
  userId: id(u._id), name: u.name, role: u.role, email: u.email, staffId: u.staffId, pharmacyName: u.pharmacyName,
  location: u.location || '', status: u.status || 'active', mustChangePassword: !!u.mustChangePassword,
  createdAt: u.createdAt ? u.createdAt.toISOString() : null,
  lastActiveAt: u.lastActiveAt ? u.lastActiveAt.toISOString() : null,
  lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  suspendedAt: u.suspendedAt ? u.suspendedAt.toISOString() : null,
});

export const presentAdmin = (a) => ({
  adminId: a.adminId, name: a.name, email: a.email, role: 'Administrator',
  createdAt: a.createdAt ? a.createdAt.toISOString() : null,
});

export const presentActivity = (a) => ({
  activityId: id(a._id), userId: id(a.userId), userName: a.userName, pharmacyName: a.pharmacyName,
  actor: a.actor, type: a.type, message: a.message, at: a.at.toISOString(),
});

export const presentSupplier = (s) => ({
  supplierId: id(s._id), userId: id(s.userId), name: s.name, contactInfo: s.contactInfo, address: s.address,
});

export const presentDrug = (d) => ({
  drugId: id(d._id), userId: id(d.userId), name: d.name, category: d.category, barcode: d.barcode, reorderLevel: d.reorderLevel,
});

export const presentBatch = (b) => ({
  batchId: id(b._id), drugId: id(b.drugId), supplierId: id(b.supplierId), batchNumber: b.batchNumber,
  quantity: b.quantity, expiryDate: dateToISO(b.expiryDate), dateReceived: dateToISO(b.dateReceived),
});

export const presentSale = (s) => ({
  saleId: id(s._id), batchId: id(s.batchId), quantitySold: s.quantitySold, dateSold: s.dateSold.toISOString(),
});

export const presentAlert = (a) => ({
  alertId: id(a._id), batchId: id(a.batchId), drugId: id(a.drugId), alertType: a.alertType, alertTier: a.alertTier,
  status: a.status, createdAt: a.createdAt.toISOString(), resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
});
