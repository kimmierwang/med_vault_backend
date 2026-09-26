// Fills the database with demo data that matches the mobile app's mock data (DEVELOPMENT ONLY):
//   npm run seed
//   - a demo pharmacy   STF-0142 / adaeze.okonkwo@medvault.app        password: medvault123
//   - 8 more pharmacy accounts (same password) with stock, sales history and an activity log, so the admin
//     console has something to show: one suspended, one brand new, one that has gone quiet, some with alerts
//   - a demo administrator (only if none exists yet)   admin@medvault.app / ADMIN-001   password: Admin@12345
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';
import { ActivityLog, Admin, Batch, Drug, Sale, Supplier, User } from '../src/models/index.js';
import { addDays, isoToDate, todayISO } from '../src/utils/dates.js';
import { reconcile } from '../src/services/alerts.js';
import { createAdmin, purgeUserData } from '../src/services/admin.js';

if (config.env === 'production' && !process.argv.includes('--force')) {
  console.error('Refusing to seed demo data with NODE_ENV=production (pass --force if you really mean it).');
  process.exit(1);
}

const PASSWORD = 'medvault123';
const ADMIN_DEMO = { name: 'MedVault Administrator', email: 'admin@medvault.app', adminId: 'ADMIN-001', password: 'Admin@12345' };
const today = todayISO();
const inDays = (n) => addDays(today, n);
const minutesAgo = (m) => new Date(Date.now() - m * 60000);
const daysAgo = (d) => new Date(Date.now() - d * 86400000);

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- The main demo pharmacy (Adaeze) ------------------------------------------------------------------
const SUPPLIERS = [
  ['Emzor Distribution Ltd', '+234 803 111 2233', 'Ikeja, Lagos'],
  ['May & Baker Nigeria Plc', '+234 802 445 9087', 'Apapa, Lagos'],
  ['Fidson Healthcare', '+234 805 300 1122', 'Ilupeju, Lagos'],
  ['Health Bridge Pharma', '+234 807 654 3210', 'Yaba, Lagos'],
];

// name, category, barcode, reorderLevel, weekly demand
const DRUGS = [
  ['Amoxicillin 500mg', 'Antibiotic', '5012345678901', 150, 90],
  ['Paracetamol 500mg', 'Analgesic', '5019988771234', 300, 220],
  ['Ciprofloxacin 250mg', 'Antibiotic', '5013321459087', 80, 20],
  ['Artemether/Lumefantrine', 'Antimalarial', '5010098234561', 100, 45],
  ['Metformin 850mg', 'Antidiabetic', '5017765432198', 120, 60],
  ['Ibuprofen 400mg', 'Analgesic', '5011122334455', 150, 70],
  ['Vitamin C 1000mg', 'Supplement', '5016677889900', 100, 40],
  ['Loratadine 10mg', 'Antihistamine', '5014455667788', 60, 25],
];

// drug index, supplier index, batch number, quantity, received (days ago), expires (days from today)
const BATCHES = [
  [0, 0, 'P2207', 240, -200, 20], [0, 0, 'P2411', 300, -30, 400],
  [1, 1, 'PC-8812', 180, -150, 9], [1, 1, 'PC-9034', 250, -20, 300],
  [2, 2, 'CF-1120', 45, -90, 640],
  [3, 3, 'AL-0407', 60, -400, -167], [3, 3, 'AL-0912', 30, -15, 200],
  [4, 2, 'MF-2210', 320, -60, 487],
  [5, 0, 'IB-3301', 210, -100, 70], [5, 0, 'IB-3350', 150, -10, 500],
  [6, 3, 'VC-7710', 140, -120, 55],
  [7, 1, 'LT-5502', 90, -180, 25],
];

// ---- The other pharmacies (what the admin console shows) ---------------------------------------------------
const CATALOG = {
  para: ['Paracetamol 500mg', 'Analgesic', 150], amox: ['Amoxicillin 500mg', 'Antibiotic', 100],
  arte: ['Artemether/Lumefantrine', 'Antimalarial', 60], lora: ['Loratadine 10mg', 'Antihistamine', 50],
  vitc: ['Vitamin C 1000mg', 'Supplement', 80], metf: ['Metformin 500mg', 'Antidiabetic', 90],
  cipro: ['Ciprofloxacin 500mg', 'Antibiotic', 60], ibu: ['Ibuprofen 400mg', 'Analgesic', 100],
};

// stock: [drug key, [[batch number, quantity, days to expiry], ...]]   weekly = units sold per week, oldest -> newest
const EXTRA = [
  { name: 'Tunde Bakare', role: 'Pharmacist', email: 'tunde@bakarechemist.ng', staffId: 'STF-0207', pharmacyName: 'Bakare & Sons Chemist', location: 'Bodija, Ibadan', createdDaysAgo: 168, activeMinutesAgo: 95,
    weekly: [58, 61, 70, 66, 74, 80], stock: [['para', [['PB-4410', 260, 210]]], ['amox', [['AX-2231', 55, 11], ['AX-2299', 60, 260]]], ['metf', [['MT-8801', 320, 340]]], ['ibu', [['IP-1120', 180, 26]]], ['vitc', [['VC-3350', 210, 400]]]] },
  { name: 'Chioma Eze', role: 'Pharmacist', email: 'chioma.eze@healthplus-enu.com', staffId: 'STF-0311', pharmacyName: 'HealthPlus Enugu', location: 'Independence Layout, Enugu', createdDaysAgo: 122, activeMinutesAgo: 340,
    weekly: [130, 122, 141, 150, 138, 157], stock: [['arte', [['AL-7710', 200, 180]]], ['para', [['PA-1180', 90, 5], ['PA-1250', 300, 240]]], ['amox', [['AM-6604', 320, 130]]], ['cipro', [['CF-2018', 45, -20]]], ['lora', [['LR-3302', 150, 320]]], ['metf', [['MM-9100', 500, 380]]]] },
  { name: 'Ibrahim Musa', role: 'Staff', email: 'ibrahim.musa@musacare.ng', staffId: 'STF-0425', pharmacyName: 'Musa Care Pharmacy', location: 'Sabon Gari, Kano', createdDaysAgo: 96, activeMinutesAgo: 1500,
    weekly: [44, 50, 47, 39, 52, 41], stock: [['para', [['MC-0101', 70, 45]]], ['arte', [['MC-0202', 120, 90]]], ['ibu', [['MC-0303', 210, 280]]], ['vitc', [['MC-0404', 30, 18]]]] },
  { name: 'Ngozi Adebayo', role: 'Pharmacist', email: 'ngozi@greenleafpharm.ng', staffId: 'STF-0533', pharmacyName: 'Greenleaf Pharmacy', location: 'Wuse II, Abuja', createdDaysAgo: 140, activeMinutesAgo: 60 * 24 * 9, status: 'suspended',
    weekly: [90, 84, 77, 31, 0, 0], stock: [['amox', [['GL-1001', 140, -12], ['GL-1002', 40, 8]]], ['para', [['GL-2001', 200, 160]]], ['metf', [['GL-3001', 60, 120]]]] },
  { name: 'Emeka Nwosu', role: 'Staff', email: 'emeka.nwosu@nwosumeds.com', staffId: 'STF-0648', pharmacyName: 'Nwosu Meds', location: 'GRA, Port Harcourt', createdDaysAgo: 61, activeMinutesAgo: 30,
    weekly: [22, 35, 41, 48, 55, 63], stock: [['para', [['NM-100', 340, 190]]], ['arte', [['NM-200', 25, 70]]], ['lora', [['NM-300', 80, 12]]], ['ibu', [['NM-400', 260, 330]]], ['cipro', [['NM-500', 100, 210]]]] },
  { name: 'Funmi Alade', role: 'Pharmacist', email: 'funmi@aladefamilypharmacy.ng', staffId: 'STF-0712', pharmacyName: 'Alade Family Pharmacy', location: 'Oke-Ilewo, Abeokuta', createdDaysAgo: 33, activeMinutesAgo: 210,
    weekly: [0, 12, 28, 30, 36, 45], stock: [['para', [['AF-11', 180, 150]]], ['amox', [['AF-12', 210, 100]]], ['vitc', [['AF-13', 95, 40]]]] },
  { name: 'Yusuf Danjuma', role: 'Pharmacist', email: 'yusuf@danjumadrugs.ng', staffId: 'STF-0819', pharmacyName: 'Danjuma Drugs', location: 'Barnawa, Kaduna', createdDaysAgo: 188, activeMinutesAgo: 60 * 24 * 41,
    weekly: [12, 9, 4, 0, 0, 0], stock: [['para', [['DD-01', 40, -30]]], ['metf', [['DD-02', 55, 95]]]] },
  { name: 'Sade Ogunleye', role: 'Staff', email: 'sade.ogunleye@gmail.com', staffId: 'STF-0904', pharmacyName: 'Ogunleye Pharmacy', location: 'Surulere, Lagos', createdDaysAgo: 2, activeMinutesAgo: 400,
    weekly: [0, 0, 0, 0, 0, 0], stock: [] },
];

// [minutes ago, staff ID, type, message] — a believable recent history for the Activity tab
const ACTIVITY = [
  [4, 'STF-0648', 'sale', 'Recorded a sale of 12 × Paracetamol 500mg'], [12, 'STF-0142', 'login', 'Signed in'],
  [26, 'STF-0648', 'stock', 'Added batch NM-400 (260 × Ibuprofen 400mg)'], [30, 'STF-0648', 'login', 'Signed in'],
  [58, 'STF-0142', 'sale', 'Recorded a sale of 6 × Amoxicillin 500mg'], [95, 'STF-0207', 'login', 'Signed in'],
  [110, 'STF-0207', 'stock', 'Added batch IP-1120 (180 × Ibuprofen 400mg)'], [150, 'STF-0142', 'alert', 'Discarded batch CF-1120 (Ciprofloxacin 250mg)'],
  [210, 'STF-0712', 'sale', 'Recorded a sale of 9 × Vitamin C 1000mg'], [212, 'STF-0712', 'login', 'Signed in'],
  [340, 'STF-0311', 'sale', 'Recorded a sale of 20 × Paracetamol 500mg'], [345, 'STF-0311', 'login', 'Signed in'],
  [400, 'STF-0904', 'signup', 'Created an account'], [520, 'STF-0311', 'stock', 'Added batch AM-6604 (320 × Amoxicillin 500mg)'],
  [760, 'STF-0142', 'stock', 'Added batch VC-7710 (140 × Vitamin C 1000mg)'], [900, 'STF-0207', 'sale', 'Recorded a sale of 14 × Metformin 500mg'],
  [1500, 'STF-0425', 'login', 'Signed in'], [1510, 'STF-0425', 'sale', 'Recorded a sale of 5 × Artemether/Lumefantrine'],
  [1700, 'STF-0142', 'alert', 'Discarded batch AL-0407 (Artemether/Lumefantrine)'], [2100, 'STF-0712', 'stock', 'Added batch AF-13 (95 × Vitamin C 1000mg)'],
  [2900, 'STF-0311', 'alert', 'Discarded batch CF-2018 (Ciprofloxacin 500mg)'], [3300, 'STF-0648', 'sale', 'Recorded a sale of 18 × Loratadine 10mg'],
  [4300, 'STF-0207', 'login', 'Signed in'], [7200, 'STF-0533', 'sale', 'Recorded a sale of 31 × Amoxicillin 500mg'],
  [12960, 'STF-0533', 'login', 'Signed in'],
];

await mongoose.connect(config.mongoUri);

// Start clean: remove the demo accounts from a previous run (and only those).
const DEMO_STAFF = ['STF-0142', ...EXTRA.map((e) => e.staffId)];
const previous = await User.find({ staffId: { $in: DEMO_STAFF } });
for (const u of previous) await purgeUserData(u);
await ActivityLog.deleteMany({ userId: { $in: previous.map((u) => u._id) } });

const passwordHash = await bcrypt.hash(PASSWORD, config.bcryptRounds);

// ---- Adaeze ------------------------------------------------------------------------------------------------
const user = await User.create({
  name: 'Adaeze Okonkwo', role: 'Pharmacist', email: 'adaeze.okonkwo@medvault.app', staffId: 'STF-0142',
  pharmacyName: 'Okonkwo Pharmacy', location: 'Ikeja, Lagos', passwordHash, createdAt: daysAgo(210), lastActiveAt: minutesAgo(12), lastLoginAt: minutesAgo(12),
});

const suppliers = await Supplier.insertMany(SUPPLIERS.map(([name, contactInfo, address]) => ({ userId: user._id, name, contactInfo, address })));
const drugs = await Drug.insertMany(DRUGS.map(([name, category, barcode, reorderLevel]) => ({ userId: user._id, name, category, barcode, reorderLevel })));
const batches = await Batch.insertMany(BATCHES.map(([d, s, batchNumber, quantity, received, expires]) => ({
  drugId: drugs[d]._id, supplierId: suppliers[s]._id, batchNumber, quantity, dateReceived: isoToDate(inDays(received)), expiryDate: isoToDate(inDays(expires)),
})));

// 12 weeks of sales history, attributed to the batch that was current on that day.
const sales = [];
drugs.forEach((drug, di) => {
  const rnd = mulberry32(1000 + di * 77);
  const perDay = DRUGS[di][4] / 7;
  const own = batches.filter((b) => String(b.drugId) === String(drug._id)).sort((a, b) => a.dateReceived - b.dateReceived);
  for (let age = 1; age <= 84; age += 1) {
    const trend = 0.85 + ((84 - age) / 84) * 0.3;
    const qty = Math.round(perDay * trend * (0.5 + rnd()));
    if (qty <= 0) continue;
    const day = isoToDate(inDays(-age));
    const batch = [...own].reverse().find((b) => b.dateReceived <= day) || own[0];
    sales.push({ batchId: batch._id, quantitySold: qty, dateSold: new Date(day.getTime() + 11 * 3600 * 1000) });
  }
});
await Sale.insertMany(sales);
await reconcile([user._id]);

// ---- The other pharmacies -----------------------------------------------------------------------------------
const byStaff = { 'STF-0142': user };
for (const e of EXTRA) {
  const u = await User.create({
    name: e.name, role: e.role, email: e.email, staffId: e.staffId, pharmacyName: e.pharmacyName, location: e.location, passwordHash,
    status: e.status || 'active', suspendedAt: e.status === 'suspended' ? daysAgo(9) : null,
    createdAt: daysAgo(e.createdDaysAgo), lastActiveAt: minutesAgo(e.activeMinutesAgo), lastLoginAt: minutesAgo(e.activeMinutesAgo),
  });
  byStaff[e.staffId] = u;
  if (!e.stock.length) continue;

  const supplier = await Supplier.create({ userId: u._id, name: 'Regional Wholesaler', contactInfo: '', address: e.location });
  const made = [];   // batch documents in creation order (used to attach sales)
  for (const [key, bs] of e.stock) {
    const [name, category, reorderLevel] = CATALOG[key];
    const drug = await Drug.create({ userId: u._id, name, category, reorderLevel });
    for (const [batchNumber, quantity, expires] of bs) {
      made.push(await Batch.create({ drugId: drug._id, supplierId: supplier._id, batchNumber, quantity, dateReceived: isoToDate(inDays(-120)), expiryDate: isoToDate(inDays(expires)) }));
    }
  }

  // Sales history: `weekly` units per rolling 7-day week, spread over the days, taken from batches that are still in date.
  const sellable = made.filter((b) => b.expiryDate >= isoToDate(today));
  const target = sellable.length ? sellable : made;
  const rows = [];
  e.weekly.forEach((units, wi) => {
    const daysInWeek = 7;
    const base = Math.floor(units / daysInWeek);
    let extra = units - base * daysInWeek;
    for (let d = 0; d < daysInWeek; d += 1) {
      const qty = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      if (qty <= 0) continue;
      const age = (e.weekly.length - 1 - wi) * 7 + d;
      const day = isoToDate(inDays(-age));
      rows.push({ batchId: target[(wi + d) % target.length]._id, quantitySold: qty, dateSold: new Date(day.getTime() + 11 * 3600 * 1000) });
    }
  });
  if (rows.length) await Sale.insertMany(rows);
  await reconcile([u._id]);
}

// ---- Activity log -------------------------------------------------------------------------------------------
await ActivityLog.insertMany(ACTIVITY.map(([m, staffId, type, message]) => {
  const u = byStaff[staffId];
  return { userId: u._id, userName: u.name, pharmacyName: u.pharmacyName, actor: 'user', type, message, at: minutesAgo(m) };
}));

// ---- Demo administrator (never replaces an existing one) -------------------------------------------------------
let adminNote;
await Admin.init();
if (await Admin.countDocuments()) adminNote = 'An administrator already exists — left unchanged.';
else { await createAdmin(ADMIN_DEMO); adminNote = `Admin login: ${ADMIN_DEMO.email} (or ${ADMIN_DEMO.adminId})  password: ${ADMIN_DEMO.password}`; }

const openAlerts = await mongoose.model('Alert').countDocuments({ status: 'Open' });
console.log(`Seeded ${1 + EXTRA.length} pharmacy accounts, ${await Drug.countDocuments()} drugs, ${await Batch.countDocuments()} batches, ${await Sale.countDocuments()} sales, ${openAlerts} open alerts, ${ACTIVITY.length} activity entries.`);
console.log(`Pharmacy login: STF-0142 (or ${user.email})  password: ${PASSWORD}   (all demo pharmacies use this password)`);
console.log(adminNote);
await mongoose.disconnect();
