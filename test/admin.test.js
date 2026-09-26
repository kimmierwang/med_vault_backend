import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medvault_test';
process.env.BCRYPT_ROUNDS = '4';
process.env.ENABLE_CRON = 'false';

const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { Admin, ActivityLog, Alert, Batch, Drug, Sale, Supplier, User } = await import('../src/models/index.js');
const { addDays, isoToDate, todayISO } = await import('../src/utils/dates.js');
const { reconcileAll } = await import('../src/services/alerts.js');
const { setPushSender } = await import('../src/services/push.js');
const { createAdmin, ensureAdmin } = await import('../src/services/admin.js');

const app = createApp();
const api = () => request(app);
const inDays = (n) => addDays(todayISO(), n);
const h = (t) => ({ Authorization: `Bearer ${t}` });

const ADMIN = { name: 'Site Admin', email: 'Admin@Test.ng', adminId: 'admin-001', password: 'Admin@12345' };
const alice = { name: 'Alice Owner', email: 'alice@test.ng', staffId: 'stf-a', role: 'Pharmacist', pharmacyName: 'Alice Pharmacy', location: 'Ikeja, Lagos', password: 'secret123' };
const bob = { name: 'Bob Stock', email: 'bob@test.ng', staffId: 'STF-B', role: 'Staff', pharmacyName: 'Bob Chemist', password: 'secret123' };
const carol = { name: 'Carol Care', email: 'carol@test.ng', staffId: 'STF-C', role: 'Pharmacist', pharmacyName: 'Carol Drugs', password: 'secret123' };

let adminToken; const t = {}; const id = {}; const ctx = {};

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  setPushSender(async () => {});
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('single administrator', () => {
  test('weak passwords and clashes with pharmacy accounts are refused', async () => {
    await assert.rejects(createAdmin({ ...ADMIN, password: 'short' }), (e) => e.status === 400);
    await assert.rejects(createAdmin({ ...ADMIN, password: 'alllowercase123' }), (e) => e.status === 400);
    await api().post('/api/auth/register').send({ ...bob, email: 'admin@test.ng', staffId: 'STF-CLASH' }).expect(201);
    await assert.rejects(createAdmin(ADMIN), (e) => e.status === 409); // a pharmacy account already uses that email
    await User.deleteOne({ staffId: 'STF-CLASH' });
  });

  test('the administrator can be created once', async () => {
    const admin = await createAdmin(ADMIN);
    assert.equal(admin.email, 'admin@test.ng');
    assert.equal(admin.adminId, 'ADMIN-001');
    assert.notEqual(admin.passwordHash, ADMIN.password);
  });

  test('a second administrator is refused by the service AND by the database', async () => {
    await assert.rejects(createAdmin({ ...ADMIN, email: 'second@test.ng', adminId: 'ADMIN-002' }), (e) => e.status === 409);
    // even code that skips every check cannot insert another admin document: `singleton` is unique
    await assert.rejects(
      Admin.create({ adminId: 'ADMIN-777', name: 'Sneaky', email: 'sneaky@test.ng', passwordHash: 'x' }),
      (e) => e.code === 11000,
    );
    assert.equal(await Admin.countDocuments(), 1);
    // the singleton marker cannot be edited away either
    await Admin.updateOne({}, { $set: { singleton: 'other' } }).catch(() => {});
    assert.equal(await Admin.countDocuments({ singleton: 'admin' }), 1);
  });

  test('start-up bootstrap never overwrites an existing admin', async () => {
    const before = await Admin.findOne().lean();
    const res = await ensureAdmin();
    assert.deepEqual(res, { created: false, exists: true });
    const after = await Admin.findOne().lean();
    assert.equal(String(after.passwordHash), String(before.passwordHash));
  });

  test('sign-up cannot take the admin email or ID', async () => {
    await api().post('/api/auth/register').send({ ...bob, email: 'ADMIN@test.ng', staffId: 'STF-X1' }).expect(409);
    await api().post('/api/auth/register').send({ ...bob, email: 'someone@test.ng', staffId: 'admin-001' }).expect(409);
    assert.equal(await User.countDocuments({ staffId: { $in: ['STF-X1', 'ADMIN-001'] } }), 0);
  });
});

describe('login and access separation', () => {
  test('the admin signs in with email or ID on the normal login endpoint', async () => {
    const byEmail = await api().post('/api/auth/login').send({ identifier: 'admin@test.ng', password: ADMIN.password }).expect(200);
    assert.equal(byEmail.body.isAdmin, true);
    assert.equal(byEmail.body.user.role, 'Administrator');
    assert.equal(byEmail.body.user.passwordHash, undefined);
    const byId = await api().post('/api/auth/login').send({ identifier: 'admin-001', password: ADMIN.password }).expect(200);
    adminToken = byId.body.token;
    await api().post('/api/auth/login').send({ identifier: 'admin@test.ng', password: 'wrong-Password1' }).expect(401);
  });

  test('pharmacy accounts register and sign in as non-admins', async () => {
    for (const [key, body] of [['alice', alice], ['bob', bob], ['carol', carol]]) {
      const res = await api().post('/api/auth/register').send(body).expect(201);
      t[key] = res.body.token; id[key] = res.body.user.userId;
      assert.equal(res.body.isAdmin, false);
    }
    const login = await api().post('/api/auth/login').send({ identifier: 'alice@test.ng', password: 'secret123' }).expect(200);
    assert.equal(login.body.isAdmin, false);
    assert.equal(login.body.user.location, 'Ikeja, Lagos');
  });

  test('tokens only work on their own side', async () => {
    await api().get('/api/admin/overview').expect(401);
    await api().get('/api/admin/overview').set(h('garbage')).expect(401);
    const asUser = await api().get('/api/admin/overview').set(h(t.alice)).expect(403);
    assert.equal(asUser.body.error.code, 'ADMIN_ONLY');
    const asAdmin = await api().get('/api/drugs').set(h(adminToken)).expect(403);
    assert.equal(asAdmin.body.error.code, 'ADMIN_TOKEN');
    await api().get('/api/auth/me').set(h(adminToken)).expect(403);
    const me = await api().get('/api/admin/me').set(h(adminToken)).expect(200);
    assert.equal(me.body.admin.email, 'admin@test.ng');
    assert.equal(me.body.managing, 3);
  });

  test('the admin account cannot be reached as a user', async () => {
    const admin = await Admin.findOne().lean();
    await api().get(`/api/admin/users/${admin._id}`).set(h(adminToken)).expect(404);
    await api().post(`/api/admin/users/${admin._id}/suspend`).set(h(adminToken)).expect(404);
    await api().delete(`/api/admin/users/${admin._id}`).set(h(adminToken)).expect(404);
    assert.equal(await Admin.countDocuments(), 1);
  });
});

describe('monitoring: overview, users, alerts, activity', () => {
  before(async () => {
    // Alice: paracetamol (critical batch + a second batch), amoxicillin (healthy)
    const d = await api().post('/api/batches').set(h(t.alice)).send({ batches: [
      { newDrug: { name: 'Paracetamol 500mg', category: 'Analgesic', reorderLevel: 100 }, newSupplierName: 'Emzor', batchNumber: 'A-1', quantity: 50, expiryDate: inDays(5) },
      { newDrug: { name: 'Paracetamol 500mg', category: 'Analgesic', reorderLevel: 100 }, newSupplierName: 'Emzor', batchNumber: 'A-2', quantity: 30, expiryDate: inDays(300) },
      { newDrug: { name: 'Amoxicillin 500mg', category: 'Antibiotic', reorderLevel: 10 }, newSupplierName: 'Emzor', batchNumber: 'AM-1', quantity: 200, expiryDate: inDays(200) },
    ] }).expect(201);
    ctx.paracetamol = d.body.createdDrugs.find((x) => x.name.startsWith('Para')).drugId;
    ctx.supplier = d.body.createdSuppliers[0].supplierId;
    ctx.batchA2 = d.body.batches.find((b) => b.batchNumber === 'A-2').batchId;
    // an already-expired batch (the API refuses to add one, so it is inserted directly)
    await Batch.create({ drugId: ctx.paracetamol, supplierId: ctx.supplier, batchNumber: 'A-OLD', quantity: 10, expiryDate: isoToDate(inDays(-10)), dateReceived: isoToDate(inDays(-100)) });
    await api().post('/api/sales').set(h(t.alice)).send({ drugId: ctx.paracetamol, quantity: 20 }).expect(201); // FEFO: from A-1
    // older sales for the weekly chart: 10 units 8 days ago, 5 units 15 days ago
    await Sale.insertMany([
      { batchId: ctx.batchA2, quantitySold: 10, dateSold: new Date(Date.now() - 8 * 86400000) },
      { batchId: ctx.batchA2, quantitySold: 5, dateSold: new Date(Date.now() - 15 * 86400000) },
    ]);
    await reconcileAll();
    // Bob: one healthy drug
    await api().post('/api/batches').set(h(t.bob)).send({ batches: [{ newDrug: { name: 'Ibuprofen 400mg', category: 'Analgesic', reorderLevel: 10 }, newSupplierName: 'Fidson', batchNumber: 'B-1', quantity: 500, expiryDate: inDays(400) }] }).expect(201);
    // Bob signed up a month ago; Carol has not been active for 40 days
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id.bob) }, { $set: { createdAt: new Date(Date.now() - 30 * 86400000) } });
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id.carol) }, { $set: { lastActiveAt: new Date(Date.now() - 40 * 86400000) } });
  });

  test('overview totals come from the real records', async () => {
    const res = await api().get('/api/admin/overview').set(h(adminToken)).expect(200);
    const o = res.body;
    assert.equal(o.totals.users, 3);
    assert.equal(o.totals.active, 3);
    assert.equal(o.totals.suspended, 0);
    assert.equal(o.totals.drugs, 3);
    assert.equal(o.totals.batches, 5);                 // A-1, A-2, A-OLD, AM-1, B-1
    assert.equal(o.totals.unitsSoldThisWeek, 20);
    assert.equal(o.totals.openAlerts, 3);              // A-1 critical, A-OLD expired, paracetamol low stock
    assert.equal(o.totals.attention, 3);
    assert.equal(o.totals.expired, 1);
    assert.equal(o.totals.newThisWeek, 2);             // Alice + Carol (Bob is a month old)
    assert.equal(o.totals.inactive, 1);                // Carol
    assert.deepEqual(o.weekly.series, [0, 0, 0, 5, 10, 20]);
    assert.equal(o.weekly.labels[5], 'This wk');
    assert.equal(o.pharmaciesNeedingAttention, 1);
    assert.equal(o.needsAttention[0].userId, id.alice);
    assert.ok(o.recentActivity.length > 0 && o.recentActivity.length <= 5);
  });

  test('users list: chips, filters, search, sorting and paging', async () => {
    const all = await api().get('/api/admin/users').set(h(adminToken)).expect(200);
    assert.deepEqual(all.body.counts, { all: 3, active: 3, suspended: 0, new: 2, inactive: 1 });
    assert.equal(all.body.users.length, 3);
    assert.equal(all.body.users[0].passwordHash, undefined);
    const a = all.body.users.find((u) => u.userId === id.alice);
    assert.equal(a.counts.drugs, 2);
    assert.equal(a.counts.openAlerts, 3);
    assert.equal(a.counts.soldThisWeek, 20);
    assert.equal(a.counts.expired, 1);
    assert.equal(a.flags.isNew, true);

    const inactive = await api().get('/api/admin/users?filter=inactive').set(h(adminToken)).expect(200);
    assert.deepEqual(inactive.body.users.map((u) => u.userId), [id.carol]);
    assert.equal(inactive.body.users[0].flags.isInactive, true);
    const isNew = await api().get('/api/admin/users?filter=new').set(h(adminToken)).expect(200);
    assert.deepEqual(isNew.body.users.map((u) => u.userId).sort(), [id.alice, id.carol].sort());

    const byPharmacy = await api().get('/api/admin/users?q=chem').set(h(adminToken)).expect(200);
    assert.deepEqual(byPharmacy.body.users.map((u) => u.userId), [id.bob]);
    const byLocation = await api().get('/api/admin/users?q=IKEJA').set(h(adminToken)).expect(200);
    assert.deepEqual(byLocation.body.users.map((u) => u.userId), [id.alice]);
    const weird = await api().get('/api/admin/users?q=(.*').set(h(adminToken)).expect(200); // regex characters are escaped
    assert.equal(weird.body.users.length, 0);

    const byName = await api().get('/api/admin/users?sort=name').set(h(adminToken)).expect(200);
    assert.deepEqual(byName.body.users.map((u) => u.name), ['Alice Owner', 'Bob Stock', 'Carol Care']);
    const p1 = await api().get('/api/admin/users?sort=name&limit=2').set(h(adminToken)).expect(200);
    const p2 = await api().get('/api/admin/users?sort=name&limit=2&page=2').set(h(adminToken)).expect(200);
    assert.equal(p1.body.users.length, 2); assert.equal(p1.body.pages, 2); assert.equal(p2.body.users.length, 1);

    await api().get('/api/admin/users?filter=bogus').set(h(adminToken)).expect(400);
    await api().get('/api/admin/users?limit=9999').set(h(adminToken)).expect(400);
  });

  test('user detail: profile, weekly sales, stock health, alerts, activity', async () => {
    const res = await api().get(`/api/admin/users/${id.alice}`).set(h(adminToken)).expect(200);
    const d = res.body;
    assert.equal(d.user.email, 'alice@test.ng');
    assert.deepEqual(d.weekly.series, [0, 0, 0, 5, 10, 20]);
    assert.equal(d.drugs[0].name, 'Paracetamol 500mg');   // worst first
    assert.equal(d.drugs[0].status, 'expired');
    assert.equal(d.drugs[0].stock, 60);                    // A-1 30 (after the sale) + A-2 30; expired A-OLD excluded
    assert.equal(d.drugs.find((x) => x.name.startsWith('Amox')).status, 'ok');
    assert.equal(d.alerts.length, 3);
    assert.ok(d.activity.some((a) => a.message === 'Recorded a sale of 20 × Paracetamol 500mg'));
    assert.ok(d.activity.length <= 5);

    await api().get(`/api/admin/users/${new mongoose.Types.ObjectId()}`).set(h(adminToken)).expect(404);
    await api().get('/api/admin/users/not-an-id').set(h(adminToken)).expect(400);
  });

  test('alerts across every pharmacy', async () => {
    const res = await api().get('/api/admin/alerts').set(h(adminToken)).expect(200);
    assert.deepEqual(res.body.counts, { all: 3, low_stock: 1, expired: 1, critical: 1, warning: 0, upcoming: 0 });
    assert.equal(res.body.pharmaciesAffected, 1);
    assert.ok(res.body.alerts.every((a) => a.pharmacy.pharmacyName === 'Alice Pharmacy' && a.pharmacy.userId === id.alice));
    assert.equal(res.body.alerts[0].alertTier, 'expired');   // most urgent first
    const exp = await api().get('/api/admin/alerts?tier=expired').set(h(adminToken)).expect(200);
    assert.equal(exp.body.alerts.length, 1);
    const low = await api().get('/api/admin/alerts?type=low_stock').set(h(adminToken)).expect(200);
    assert.equal(low.body.alerts.length, 1);
    const none = await api().get('/api/admin/alerts?q=bob').set(h(adminToken)).expect(200);
    assert.equal(none.body.counts.all, 0);
    const paged = await api().get('/api/admin/alerts?limit=2&page=2').set(h(adminToken)).expect(200);
    assert.equal(paged.body.alerts.length, 1); assert.equal(paged.body.total, 3);
  });

  test('activity log records what pharmacies and the admin do', async () => {
    const res = await api().get('/api/admin/activity').set(h(adminToken)).expect(200);
    const { activity, counts } = res.body;
    assert.equal(counts.all, counts.access + counts.stock + counts.sale + counts.admin);  // the groups partition the log
    assert.ok(activity.some((a) => a.type === 'signup' && a.userName === 'Alice Owner'));
    assert.ok(activity.some((a) => a.type === 'stock' && a.message === 'Added batch A-1 (50 × Paracetamol 500mg)'));
    assert.ok(activity.some((a) => a.type === 'sale' && a.pharmacyName === 'Alice Pharmacy'));
    assert.ok(activity.some((a) => a.type === 'login' && a.userName === 'Alice Owner'));
    assert.ok(activity.some((a) => a.type === 'admin' && a.actor === 'admin' && a.message === 'Administrator signed in'));
    for (let i = 1; i < activity.length; i += 1) assert.ok(activity[i - 1].at >= activity[i].at); // newest first

    const sales = await api().get('/api/admin/activity?group=sale').set(h(adminToken)).expect(200);
    assert.ok(sales.body.activity.length >= 1 && sales.body.activity.every((a) => a.type === 'sale'));
    const mine = await api().get(`/api/admin/activity?userId=${id.alice}`).set(h(adminToken)).expect(200);
    assert.ok(mine.body.activity.every((a) => a.userId === id.alice));
    await api().get('/api/admin/activity?group=nope').set(h(adminToken)).expect(400);
  });

  test('users CSV export is protected against spreadsheet formulas', async () => {
    await api().post('/api/auth/register').send({ ...bob, name: '=SUM(1+1)', email: 'evil@test.ng', staffId: 'STF-EVIL', pharmacyName: '@evil' }).expect(201);
    const res = await api().get('/api/admin/users/export.csv').set(h(adminToken)).expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /medvault-users-/);
    assert.ok(res.text.startsWith('"Name","Pharmacy"'));
    assert.ok(res.text.includes('"Alice Owner"'));
    assert.ok(res.text.includes(`"'=SUM(1+1)"`));   // neutralised
    assert.ok(!res.text.includes(`,"=SUM`) && !res.text.startsWith('"=SUM') && !res.text.includes('\n"=SUM'));
    await api().get('/api/admin/users/export.csv').set(h(t.alice)).expect(403);
    await User.deleteOne({ staffId: 'STF-EVIL' });
  });
});

describe('controlling accounts', () => {
  test('suspend blocks sign-in and open sessions immediately; reactivate restores them', async () => {
    const before = await api().get('/api/drugs').set(h(t.carol)).expect(200);
    assert.ok(before.body);
    const res = await api().post(`/api/admin/users/${id.carol}/suspend`).set(h(adminToken)).expect(200);
    assert.equal(res.body.user.status, 'suspended');

    const login = await api().post('/api/auth/login').send({ identifier: 'carol@test.ng', password: 'secret123' }).expect(403);
    assert.equal(login.body.error.code, 'ACCOUNT_SUSPENDED');
    await api().post('/api/auth/login').send({ identifier: 'carol@test.ng', password: 'wrong-pass' }).expect(401); // no hint to someone without the password
    const old = await api().get('/api/drugs').set(h(t.carol));
    assert.ok([401, 403].includes(old.status));                                   // the session she had is over

    const list = await api().get('/api/admin/users?filter=suspended').set(h(adminToken)).expect(200);
    assert.deepEqual(list.body.users.map((u) => u.userId), [id.carol]);
    const overview = await api().get('/api/admin/overview').set(h(adminToken)).expect(200);
    assert.equal(overview.body.totals.suspended, 1);
    assert.equal(overview.body.totals.active, 2);

    await api().post(`/api/admin/users/${id.carol}/suspend`).set(h(adminToken)).expect(200); // idempotent

    const back = await api().post(`/api/admin/users/${id.carol}/reactivate`).set(h(adminToken)).expect(200);
    assert.equal(back.body.user.status, 'active');
    const again = await api().post('/api/auth/login').send({ identifier: 'carol@test.ng', password: 'secret123' }).expect(200);
    t.carol = again.body.token;
    await api().get('/api/drugs').set(h(t.carol)).expect(200);
  });

  test('reset password: temporary password, old sessions end, new password is forced', async () => {
    const res = await api().post(`/api/admin/users/${id.bob}/reset-password`).set(h(adminToken)).expect(200);
    const temp = res.body.temporaryPassword;
    assert.match(temp, /^MV-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.user.passwordHash, undefined);

    const oldSession = await api().get('/api/drugs').set(h(t.bob)).expect(401);
    assert.equal(oldSession.body.error.code, 'SESSION_ENDED');
    await api().post('/api/auth/login').send({ identifier: 'bob@test.ng', password: 'secret123' }).expect(401);

    const login = await api().post('/api/auth/login').send({ identifier: 'bob@test.ng', password: temp }).expect(200);
    assert.equal(login.body.mustChangePassword, true);
    const tempToken = login.body.token;
    const blocked = await api().get('/api/drugs').set(h(tempToken)).expect(403);
    assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    await api().get('/api/auth/me').set(h(tempToken)).expect(200);

    await api().post('/api/auth/change-password').set(h(tempToken)).send({ currentPassword: 'not-the-temp', newPassword: 'brand-new-pass' }).expect(401);
    await api().post('/api/auth/change-password').set(h(tempToken)).send({ currentPassword: temp, newPassword: 'abc' }).expect(400);
    const changed = await api().post('/api/auth/change-password').set(h(tempToken)).send({ currentPassword: temp, newPassword: 'brand-new-pass' }).expect(200);
    t.bob = changed.body.token;
    await api().get('/api/drugs').set(h(t.bob)).expect(200);
    await api().get('/api/drugs').set(h(tempToken)).expect(401);                       // the temp session ended too
    await api().post('/api/auth/login').send({ identifier: 'bob@test.ng', password: temp }).expect(401);
    await api().post('/api/auth/login').send({ identifier: 'bob@test.ng', password: 'brand-new-pass' }).expect(200);

    // the password is never written to the activity log
    const log = await ActivityLog.find().lean();
    assert.ok(log.every((l) => !l.message.includes(temp)));
    assert.ok(log.some((l) => l.message === 'Reset the password for Bob Stock'));
  });

  test('delete removes the account and everything it owns, and nothing else', async () => {
    const aliceDrugs = (await Drug.find({ userId: id.alice }, '_id').lean()).map((d) => d._id);
    const aliceBatches = (await Batch.find({ drugId: { $in: aliceDrugs } }, '_id').lean()).map((b) => b._id);
    assert.ok(aliceDrugs.length && aliceBatches.length);
    assert.ok(await Sale.countDocuments({ batchId: { $in: aliceBatches } }) > 0);
    const bobDrugs = await Drug.countDocuments({ userId: id.bob });
    const bobBatches = await Batch.countDocuments({ drugId: { $in: (await Drug.find({ userId: id.bob }, '_id').lean()).map((d) => d._id) } });

    const res = await api().delete(`/api/admin/users/${id.alice}`).set(h(adminToken)).expect(200);
    assert.equal(res.body.deleted, true);

    assert.equal(await User.countDocuments({ _id: id.alice }), 0);
    assert.equal(await Drug.countDocuments({ userId: id.alice }), 0);
    assert.equal(await Supplier.countDocuments({ userId: id.alice }), 0);
    assert.equal(await Batch.countDocuments({ _id: { $in: aliceBatches } }), 0);
    assert.equal(await Sale.countDocuments({ batchId: { $in: aliceBatches } }), 0);
    assert.equal(await Alert.countDocuments({ $or: [{ batchId: { $in: aliceBatches } }, { drugId: { $in: aliceDrugs } }] }), 0);
    // other pharmacies untouched
    assert.equal(await Drug.countDocuments({ userId: id.bob }), bobDrugs);
    assert.equal(await Batch.countDocuments({ drugId: { $in: (await Drug.find({ userId: id.bob }, '_id').lean()).map((d) => d._id) } }), bobBatches);

    await api().post('/api/auth/login').send({ identifier: 'alice@test.ng', password: 'secret123' }).expect(401);
    await api().get('/api/drugs').set(h(t.alice)).expect(401);
    await api().get(`/api/admin/users/${id.alice}`).set(h(adminToken)).expect(404);
    await api().delete(`/api/admin/users/${id.alice}`).set(h(adminToken)).expect(404);

    // the audit trail survives the account and still names it
    const log = await api().get('/api/admin/activity?group=admin').set(h(adminToken)).expect(200);
    assert.ok(log.body.activity.some((a) => a.message === 'Deleted the account of Alice Owner (Alice Pharmacy)' && a.actor === 'admin'));
    const overview = await api().get('/api/admin/overview').set(h(adminToken)).expect(200);
    assert.equal(overview.body.totals.users, 2);
    assert.equal(overview.body.totals.openAlerts, 0);
  });
});

describe('admin account', () => {
  test('the admin can change their own password; old sessions end', async () => {
    await api().post('/api/admin/change-password').set(h(adminToken)).send({ currentPassword: 'wrong', newPassword: 'New-Passw0rd-42' }).expect(401);
    await api().post('/api/admin/change-password').set(h(adminToken)).send({ currentPassword: ADMIN.password, newPassword: 'weak' }).expect(400);
    const res = await api().post('/api/admin/change-password').set(h(adminToken)).send({ currentPassword: ADMIN.password, newPassword: 'New-Passw0rd-42' }).expect(200);
    await api().get('/api/admin/overview').set(h(adminToken)).expect(401);       // the old token no longer works
    await api().get('/api/admin/overview').set(h(res.body.token)).expect(200);
    await api().post('/api/auth/login').send({ identifier: 'admin@test.ng', password: ADMIN.password }).expect(401);
    await api().post('/api/auth/login').send({ identifier: 'admin@test.ng', password: 'New-Passw0rd-42' }).expect(200);
    assert.equal(await Admin.countDocuments(), 1);
  });

  test('unknown admin routes return a JSON 404', async () => {
    const login = await api().post('/api/auth/login').send({ identifier: 'admin@test.ng', password: 'New-Passw0rd-42' }).expect(200);
    const res = await api().get('/api/admin/nothing').set(h(login.body.token)).expect(404);
    assert.ok(res.body.error.message);
  });
});
