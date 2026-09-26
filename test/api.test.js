import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medvault_test';
process.env.BCRYPT_ROUNDS = '4';
process.env.ENABLE_CRON = 'false';

const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { Batch, Drug, Sale } = await import('../src/models/index.js');
const { addDays, isoToDate, todayISO } = await import('../src/utils/dates.js');
const { reconcileAll } = await import('../src/services/alerts.js');
const { setPushSender } = await import('../src/services/push.js');
const { movingAverage, exponentialSmoothing } = await import('../src/services/forecast.js');

const app = createApp();
const api = () => request(app);
const inDays = (n) => addDays(todayISO(), n);

const owner = { name: 'Test Pharmacist', email: 'Owner@Test.ng', staffId: 'stf-1', role: 'Pharmacist', pharmacyName: 'Test Pharmacy', password: 'secret123' };
const other = { name: 'Other Person', email: 'other@test.ng', staffId: 'STF-2', role: 'Pharmacist', pharmacyName: 'Other Pharmacy', password: 'secret123' };

let token; let otherToken;
const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
const ctx = {}; // ids shared between tests
const pushed = [];

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  setPushSender(async (messages) => { pushed.push(...messages); });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('auth', () => {
  test('health check', async () => {
    const res = await api().get('/health').expect(200);
    assert.equal(res.body.database, 'connected');
  });

  test('register creates an account and returns a token', async () => {
    const res = await api().post('/api/auth/register').send(owner).expect(201);
    token = res.body.token;
    assert.ok(token);
    assert.equal(res.body.user.email, 'owner@test.ng');
    assert.equal(res.body.user.staffId, 'STF-1');
    assert.equal(res.body.user.passwordHash, undefined);
  });

  test('register rejects duplicate email / staff ID and weak input', async () => {
    await api().post('/api/auth/register').send({ ...owner, staffId: 'STF-9' }).expect(409);
    await api().post('/api/auth/register').send({ ...owner, email: 'new@test.ng' }).expect(409);
    await api().post('/api/auth/register').send({ ...owner, email: 'x@test.ng', staffId: 'STF-8', password: '123' }).expect(400);
    await api().post('/api/auth/register').send({ ...owner, email: 'x@test.ng', staffId: 'STF-8', role: 'Janitor' }).expect(400);
  });

  test('login works with email or staff ID, and rejects a wrong password', async () => {
    await api().post('/api/auth/login').send({ identifier: 'owner@test.ng', password: 'secret123' }).expect(200);
    const res = await api().post('/api/auth/login').send({ identifier: 'stf-1', password: 'secret123' }).expect(200);
    assert.ok(res.body.token);
    await api().post('/api/auth/login').send({ identifier: 'stf-1', password: 'nope' }).expect(401);
  });

  test('protected routes need a valid token', async () => {
    await api().get('/api/drugs').expect(401);
    await api().get('/api/drugs').set({ Authorization: 'Bearer garbage' }).expect(401);
    await api().get('/api/auth/me').set(auth()).expect(200);
    const res = await api().post('/api/auth/register').send(other).expect(201);
    otherToken = res.body.token;
  });
});

describe('drugs and suppliers', () => {
  test('create a drug and look it up by barcode', async () => {
    const res = await api().post('/api/drugs').set(auth()).send({ name: 'Paracetamol 500mg', category: 'Analgesic', barcode: '111222333', reorderLevel: 30 }).expect(201);
    ctx.paracetamol = res.body.drug.drugId;
    assert.equal(res.body.drug.stock, 0);
    assert.equal(res.body.drug.lowStock, true);
    const found = await api().get('/api/drugs/barcode/111222333').set(auth()).expect(200);
    assert.equal(found.body.drug.drugId, ctx.paracetamol);
    await api().get('/api/drugs/barcode/000').set(auth()).expect(404);
    await api().post('/api/drugs').set(auth()).send({ name: 'Copy', barcode: '111222333' }).expect(409);
  });

  test('suppliers: create, and creating the same name again returns the existing one', async () => {
    const a = await api().post('/api/suppliers').set(auth()).send({ name: 'Emzor Ltd', contactInfo: '080', address: 'Lagos' }).expect(201);
    ctx.supplier = a.body.supplier.supplierId;
    const b = await api().post('/api/suppliers').set(auth()).send({ name: 'EMZOR LTD' }).expect(200);
    assert.equal(b.body.supplier.supplierId, ctx.supplier);
  });
});

describe('batches and alerts', () => {
  test('rejects a delivery with an expired date or a duplicate batch number', async () => {
    const base = { drugId: ctx.paracetamol, supplierId: ctx.supplier, batchNumber: 'X1', quantity: 5 };
    await api().post('/api/batches').set(auth()).send({ batches: [{ ...base, expiryDate: inDays(-1) }] }).expect(400);
    await api().post('/api/batches').set(auth()).send({ batches: [{ ...base, expiryDate: inDays(50) }, { ...base, expiryDate: inDays(60) }] }).expect(400);
    await api().post('/api/batches').set(auth()).send({ batches: [{ ...base, expiryDate: '2026-13-45' }] }).expect(400);
    await api().post('/api/batches').set(auth()).send({ batches: [{ ...base, drugId: undefined, expiryDate: inDays(50) }] }).expect(400);
  });

  test('saves a delivery (existing drug + new drug + new supplier) and opens alerts', async () => {
    const res = await api().post('/api/batches').set(auth()).send({
      batches: [
        { drugId: ctx.paracetamol, supplierId: ctx.supplier, batchNumber: 'PC-A', quantity: 5, expiryDate: inDays(20) },
        { drugId: ctx.paracetamol, supplierId: ctx.supplier, batchNumber: 'PC-B', quantity: 10, expiryDate: inDays(300) },
        { newDrug: { name: 'Amoxicillin 500mg', category: 'Antibiotic', barcode: '999888', reorderLevel: 50 }, newSupplierName: 'Fidson', batchNumber: 'AM-1', quantity: 100, expiryDate: inDays(9) },
      ],
    }).expect(201);
    assert.equal(res.body.batches.length, 3);
    assert.equal(res.body.createdDrugs.length, 1);
    assert.equal(res.body.createdSuppliers.length, 1);
    ctx.amox = res.body.createdDrugs[0].drugId;
    ctx.batchA = res.body.batches[0].batchId;
    ctx.batchB = res.body.batches[1].batchId;
    ctx.batchAmox = res.body.batches[2].batchId;

    const alerts = await api().get('/api/alerts').set(auth()).expect(200);
    const kinds = alerts.body.alerts.map((a) => `${a.alertType}:${a.alertTier}:${a.batch?.batchNumber ?? a.drug.name}`).sort();
    assert.deepEqual(kinds, ['expiry:critical:AM-1', 'expiry:warning:PC-A', 'low_stock:warning:Paracetamol 500mg']);
    assert.equal(alerts.body.alerts[0].alertTier, 'critical'); // most urgent first
    assert.equal(alerts.body.counts.all, 3);
    assert.equal(alerts.body.counts.critical, 1);
    assert.equal(alerts.body.counts.low_stock, 1);
  });

  test('batch list is sorted by urgency and carries drug / tier', async () => {
    const res = await api().get('/api/batches').set(auth()).expect(200);
    assert.deepEqual(res.body.batches.map((b) => b.batchNumber), ['AM-1', 'PC-A', 'PC-B']);
    assert.equal(res.body.batches[0].tier, 'critical');
    assert.equal(res.body.batches[0].drug.name, 'Amoxicillin 500mg');
    const filtered = await api().get('/api/batches?q=pc-b').set(auth()).expect(200);
    assert.equal(filtered.body.batches.length, 1);
  });

  test('editing an expiry date moves the alert to the right tier', async () => {
    await api().post('/api/push/token').set(auth()).send({ token: 'ExponentPushToken[abcdefghijklmnopqrstuv]', enabled: true }).expect(201);
    pushed.length = 0;
    await api().patch(`/api/batches/${ctx.batchA}`).set(auth()).send({ expiryDate: inDays(5) }).expect(200);
    const alerts = await api().get('/api/alerts?tier=critical').set(auth()).expect(200);
    assert.equal(alerts.body.alerts.length, 2);
    assert.equal(pushed.length, 1, 'a push notification is sent when an alert gets worse');
    assert.match(pushed[0].body, /PC-A/);
    await api().patch(`/api/batches/${ctx.batchA}`).set(auth()).send({ expiryDate: inDays(20) }).expect(200);
  });

  test('discarding a batch resolves its alert', async () => {
    const res = await api().post(`/api/batches/${ctx.batchAmox}/discard`).set(auth()).expect(200);
    assert.equal(res.body.batch.quantity, 0);
    const open = await api().get('/api/alerts').set(auth()).expect(200);
    assert.ok(!open.body.alerts.some((a) => a.batch?.batchNumber === 'AM-1'));
    const resolved = await api().get('/api/alerts?status=Resolved').set(auth()).expect(200);
    assert.equal(resolved.body.alerts.length, 1);
    assert.equal(resolved.body.alerts[0].status, 'Resolved');
    assert.ok(resolved.body.alerts[0].resolvedAt);
  });

  test('changing a drug reorder level updates the low-stock alert', async () => {
    const lowFor = async (drugId) => {
      const res = await api().get('/api/alerts?type=low_stock').set(auth()).expect(200);
      return res.body.alerts.filter((a) => a.drug.drugId === drugId);
    };
    assert.equal((await lowFor(ctx.paracetamol)).length, 1);
    // Amoxicillin has no sellable stock left after its only batch was discarded -> critical low-stock alert
    const amox = await lowFor(ctx.amox);
    assert.equal(amox.length, 1);
    assert.equal(amox[0].alertTier, 'critical');
    assert.equal(amox[0].batch, null);
    await api().patch(`/api/drugs/${ctx.paracetamol}`).set(auth()).send({ reorderLevel: 5 }).expect(200);
    assert.equal((await lowFor(ctx.paracetamol)).length, 0);
    await api().patch(`/api/drugs/${ctx.paracetamol}`).set(auth()).send({ reorderLevel: 30 }).expect(200);
    assert.equal((await lowFor(ctx.paracetamol)).length, 1);
  });

  test('running the reconcile job twice does not create duplicate alerts', async () => {
    await reconcileAll();
    await reconcileAll();
    const alerts = await api().get('/api/alerts').set(auth()).expect(200);
    assert.equal(alerts.body.alerts.length, 3); // PC-A expiry, Paracetamol low stock, Amoxicillin low stock
  });
});

describe('sales (FEFO)', () => {
  test('a sale is taken from the earliest-expiring batch first and spans batches when needed', async () => {
    const res = await api().post('/api/sales').set(auth()).send({ drugId: ctx.paracetamol, quantity: 8 }).expect(201);
    assert.deepEqual(res.body.picks.map((p) => [p.batchNumber, p.quantity]), [['PC-A', 5], ['PC-B', 3]]);
    assert.equal(res.body.sales.length, 2, 'one Sale row per batch used');
    assert.equal(res.body.sales[0].batchId, ctx.batchA);

    const batches = await api().get('/api/batches?status=all').set(auth()).expect(200);
    const qty = Object.fromEntries(batches.body.batches.map((b) => [b.batchNumber, b.quantity]));
    assert.equal(qty['PC-A'], 0);
    assert.equal(qty['PC-B'], 7);
    // PC-A is sold out, so its expiry alert is resolved
    const open = await api().get('/api/alerts').set(auth()).expect(200);
    assert.ok(!open.body.alerts.some((a) => a.batch?.batchNumber === 'PC-A'));
  });

  test('cannot sell more than the sellable stock', async () => {
    const res = await api().post('/api/sales').set(auth()).send({ drugId: ctx.paracetamol, quantity: 100 }).expect(409);
    assert.equal(res.body.error.details.available, 7);
    await api().post('/api/sales').set(auth()).send({ drugId: ctx.paracetamol, quantity: 0 }).expect(400);
    await api().post('/api/sales').set(auth()).send({ drugId: 'nope', quantity: 1 }).expect(400);
  });

  test('expired stock is never sold and does not count as stock', async () => {
    await Batch.create({ drugId: ctx.paracetamol, supplierId: ctx.supplier, batchNumber: 'PC-OLD', quantity: 50, dateReceived: isoToDate(inDays(-400)), expiryDate: isoToDate(inDays(-1)) });
    await api().post('/api/sales').set(auth()).send({ drugId: ctx.paracetamol, quantity: 20 }).expect(409);
    const drug = await api().get(`/api/drugs/${ctx.paracetamol}`).set(auth()).expect(200);
    assert.equal(drug.body.drug.stock, 7);
    const alerts = await api().post('/api/alerts/refresh').set(auth()).expect(200);
    assert.equal(alerts.body.opened, 1); // the expired batch is flagged
    const list = await api().get('/api/alerts?tier=expired').set(auth()).expect(200);
    assert.equal(list.body.alerts[0].batch.batchNumber, 'PC-OLD');
  });

  test("today's sales log groups the rows of one sale", async () => {
    const res = await api().get('/api/sales/today').set(auth()).expect(200);
    assert.equal(res.body.groups.length, 1);
    assert.equal(res.body.groups[0].quantity, 8);
    assert.equal(res.body.groups[0].batches.length, 2);
    assert.equal(res.body.totalUnits, 8);
    const history = await api().get('/api/sales?days=30').set(auth()).expect(200);
    assert.equal(history.body.sales.length, 2);
    const day = await api().get(`/api/sales?date=${todayISO()}`).set(auth()).expect(200);
    assert.equal(day.body.groups.length, 1);
    const none = await api().get(`/api/sales?date=${inDays(-3)}`).set(auth()).expect(200);
    assert.equal(none.body.groups.length, 0);
  });
});

describe('forecast', () => {
  test('weekly totals, moving average, smoothing and reorder quantity', async () => {
    // Weekly sales for Amoxicillin over the last 6 weeks, oldest -> newest
    const weekly = [10, 20, 30, 40, 50, 60];
    const batch = await Batch.findById(ctx.batchAmox);
    const rows = weekly.map((qty, i) => ({ batchId: batch._id, quantitySold: qty, dateSold: new Date(Date.now() - ((5 - i) * 7 + 2) * 86400000) }));
    await Sale.insertMany(rows);
    // stock for Amoxicillin: the AM-1 batch was discarded, so add fresh stock of 20
    await api().post('/api/batches').set(auth()).send({ batches: [{ drugId: ctx.amox, supplierId: ctx.supplier, batchNumber: 'AM-2', quantity: 20, expiryDate: inDays(200) }] }).expect(201);

    const res = await api().get(`/api/forecast/${ctx.amox}?leadTimeWeeks=2`).set(auth()).expect(200);
    const f = res.body.forecast;
    assert.deepEqual(f.series, weekly);
    assert.equal(f.labels[5], 'This wk');
    const ma = movingAverage(weekly);
    const es = exponentialSmoothing(weekly);
    assert.equal(f.movingAverage, Math.round(ma * 10) / 10);
    assert.equal(f.exponentialSmoothing, Math.round(es * 10) / 10);
    const expected = Math.max(0, Math.ceil(((ma + es) / 2) * 2 + 50 - 20));
    assert.equal(f.suggestedReorder, expected);
    assert.equal(f.stock, 20);

    const overview = await api().get('/api/forecast').set(auth()).expect(200);
    assert.equal(overview.body.forecasts.length, 2);
    await api().get('/api/forecast/abc').set(auth()).expect(400);
  });
});

describe('dashboard, export and isolation', () => {
  test('dashboard totals', async () => {
    const res = await api().get('/api/dashboard').set(auth()).expect(200);
    assert.equal(res.body.drugsTracked, 2);
    assert.equal(res.body.expired, 1);
    assert.ok(res.body.openAlerts >= 2);
    assert.ok(res.body.needsAttention.length <= 5);
  });

  test('CSV export', async () => {
    const res = await api().get('/api/export/inventory.csv').set(auth()).expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /medvault-inventory-/);
    assert.match(res.text.split('\n')[0], /"Drug","Category","Barcode","Batch number"/);
    assert.match(res.text, /PC-B/);
  });

  test('another account cannot see or touch this pharmacy\'s data', async () => {
    const drugs = await api().get('/api/drugs').set(auth(otherToken)).expect(200);
    assert.equal(drugs.body.drugs.length, 0);
    await api().get(`/api/drugs/${ctx.paracetamol}`).set(auth(otherToken)).expect(404);
    await api().patch(`/api/batches/${ctx.batchB}`).set(auth(otherToken)).send({ quantity: 1 }).expect(404);
    await api().post('/api/sales').set(auth(otherToken)).send({ drugId: ctx.paracetamol, quantity: 1 }).expect(404);
    await api().get(`/api/forecast/${ctx.paracetamol}`).set(auth(otherToken)).expect(404);
    const alerts = await api().get('/api/alerts').set(auth(otherToken)).expect(200);
    assert.equal(alerts.body.alerts.length, 0);
    const suppliers = await api().get('/api/suppliers').set(auth(otherToken)).expect(200);
    assert.equal(suppliers.body.suppliers.length, 0);
    await api().post('/api/batches').set(auth(otherToken)).send({ batches: [{ drugId: ctx.paracetamol, supplierId: ctx.supplier, batchNumber: 'Z', quantity: 1, expiryDate: inDays(90) }] }).expect(404);
  });

  test('unknown route returns a JSON 404', async () => {
    const res = await api().get('/api/nothing').set(auth()).expect(404);
    assert.ok(res.body.error.message);
  });
});
