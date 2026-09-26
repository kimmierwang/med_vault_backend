import { dateToISO, daysUntil } from '../utils/dates.js';

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function buildInventoryCsv({ drugs, batches, suppliers }) {
  const drugById = new Map(drugs.map((d) => [String(d._id), d]));
  const supplierById = new Map(suppliers.map((s) => [String(s._id), s]));
  const header = ['Drug', 'Category', 'Barcode', 'Batch number', 'Supplier', 'Quantity', 'Date received', 'Expiry date', 'Days to expiry'];
  const rows = batches
    .filter((b) => b.quantity > 0)
    .map((b) => {
      const d = drugById.get(String(b.drugId)) || {};
      const s = supplierById.get(String(b.supplierId)) || {};
      return [d.name, d.category, d.barcode, b.batchNumber, s.name, b.quantity, dateToISO(b.dateReceived), dateToISO(b.expiryDate), daysUntil(b.expiryDate)];
    });
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

// Users export for the admin. Names and pharmacies are typed in by users, so text that a spreadsheet could read as a
// formula (starts with = + - @) is prefixed with an apostrophe (CSV injection). Numbers are left alone.
const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function buildUsersCsv(rows) {
  const header = ['Name', 'Pharmacy', 'Role', 'Email', 'Staff ID', 'Location', 'Status', 'Joined', 'Last active', 'Drugs', 'Open alerts'];
  const lines = rows.map((r) => [r.name, r.pharmacyName, r.role, r.email, r.staffId, r.location, r.status, r.createdAt?.slice(0, 10), r.lastActiveAt?.slice(0, 10), r.counts.drugs, r.counts.openAlerts]);
  return [header, ...lines].map((r) => r.map((v) => esc(safe(v))).join(',')).join('\n');
}
