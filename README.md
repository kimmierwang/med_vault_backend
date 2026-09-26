# MedVault Backend

Node.js + Express + MongoDB (Mongoose) REST API for the MedVault app: pharmacy stock by batch,
tiered expiry / low-stock alerts, FEFO sales and demand forecasting.

The data model is the ERD from the documentation (`ERD_MedVault.png` in the app project's `docs/`).
Six collections: **User, Supplier, Drug, Batch, Sale, Alert** (+ `DeviceToken` for push, and `Admin` + `ActivityLog` for the
admin console; these three are infrastructure and not part of the ERD).

## Run it

```bash
npm install
cp .env.example .env        # set MONGODB_URI and JWT_SECRET
npm run seed                # optional demo data (9 pharmacies + a demo admin) that matches the app's mock data
npm run create-admin        # creates THE administrator (see "Administrator" below)
npm start                   # http://localhost:4000  (npm run dev to auto-restart)
```

Demo logins after seeding (development only — the seed refuses to run when `NODE_ENV=production`):
pharmacy `STF-0142` (or `adaeze.okonkwo@medvault.app`) / `medvault123` (all 9 demo pharmacies share that password),
administrator `admin@medvault.app` (or `ADMIN-001`) / `Admin@12345`.

MongoDB: install it locally or use a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster and paste its
connection string into `MONGODB_URI`.

Test the API in Postman: import `docs/MedVault.postman_collection.json` (Login stores the token for the other requests).

## Tests

```bash
npm test
```

43 integration tests: 23 cover auth, scan lookup, bulk delivery, alerts (open / escalate / resolve), FEFO sales across
batches, expired stock, forecast maths, dashboard, CSV and account isolation; 20 cover the administrator (see below). They need a MongoDB at
`mongodb://127.0.0.1:27017` (override with `TEST_MONGODB_URI`) and use a separate `medvault_test` database that
is dropped at the start and end of the run.

## API

All routes are under `/api`. Everything except register/login needs `Authorization: Bearer <token>`.
Errors look like `{ "error": { "message": "...", "details": [...] } }`.

| Screen (documentation) | Method & path | Purpose |
| --- | --- | --- |
| 4.1.0 Login | `POST /auth/register`, `POST /auth/login` | Login with email **or** staff ID |
| | `GET /auth/me` | Current user |
| 4.1.1 Home | `GET /dashboard` | Drugs tracked, expiring soon, low stock, "Needs attention" |
| 4.1.2 Scan / add stock | `GET /drugs/barcode/:code` | Scan lookup (404 = new drug) |
| | `POST /batches` | Save a whole delivery: existing or new drugs, existing or new suppliers |
| Inventory | `GET /batches?status=&q=&drugId=` | Batches, most urgent tier first |
| | `PATCH /batches/:id`, `POST /batches/:id/discard` | Edit or discard a batch |
| | `GET /drugs`, `POST /drugs`, `PATCH /drugs/:id` | Drugs with usable stock; edit incl. reorder level |
| | `GET /suppliers`, `POST /suppliers` | Suppliers |
| 4.1.3 Alerts | `GET /alerts?status=&tier=&type=` | Open / Resolved alerts + filter-chip counts |
| | `POST /alerts/refresh` | Re-check now |
| 4.1.4 Record sale | `POST /sales` `{drugId, quantity}` | FEFO sale, one Sale row per batch used |
| | `GET /sales/today`, `GET /sales?days=30` or `?date=` | Today's log, sales history |
| 4.1.5 Forecast | `GET /forecast`, `GET /forecast/:drugId?leadTimeWeeks=` | Weekly series, moving average, smoothing, suggested reorder |
| Export | `GET /export/inventory.csv` | Inventory as CSV |
| Push | `POST /push/token`, `DELETE /push/token` | Register the device's Expo push token |
| | `GET /health` | Liveness + database status |

## Administrator (admin console API)

One administrator controls and monitors every pharmacy account. It backs the app's admin section
(Overview, Users, Monitor, Activity, Account); response fields line up with the app's `AdminContext`.

**Only one admin, enforced three ways**
1. The admin is a separate `Admin` document with a constant, immutable, **unique** `singleton` field, so MongoDB itself
   rejects a second admin even if some code path forgot to check (tested).
2. There is no API to create, promote, suspend or delete an admin. The admin is created only on the server:
   `ADMIN_EMAIL` + `ADMIN_PASSWORD` at first start, or `ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run create-admin`.
   Both refuse when an admin already exists and never overwrite it.
3. Sign-up rejects the admin's email and ID, and the admin cannot be reached through `/admin/users/:id`.
   Lost password: run `npm run create-admin -- --reset-password` on the server with `ADMIN_PASSWORD` set.

**Sign in** with the normal `POST /auth/login` (email or admin ID). The response has `isAdmin: true` and an admin token
(12 h); the app then opens the admin console. Admin tokens only work on `/api/admin/*`, pharmacy tokens get `403 ADMIN_ONLY`
there, and admin tokens get `403 ADMIN_TOKEN` on the pharmacy routes.

| Admin screen | Method & path | Purpose |
| --- | --- | --- |
| Account | `GET /admin/me`, `POST /admin/change-password` | Admin profile; change password (ends other admin sessions) |
| Overview | `GET /admin/overview` | Totals, weekly units sold across all pharmacies, pharmacies needing attention, recent activity |
| Users | `GET /admin/users?filter=&q=&sort=&page=&limit=` | `filter` all / active / suspended / new / inactive, search name, pharmacy, email, staff ID, location; chip `counts` included |
| | `GET /admin/users/export.csv` | All users as CSV (formula-injection safe) |
| User detail | `GET /admin/users/:id` | Profile, counts, weekly sales, stock health per drug, open alerts, recent activity |
| | `POST /admin/users/:id/suspend`, `…/reactivate` | Suspend takes effect immediately, including sessions already open |
| | `POST /admin/users/:id/reset-password` | Returns a temporary password **once**; old password and sessions stop working; the user must choose a new one |
| | `DELETE /admin/users/:id` | Permanently removes the account and its suppliers, drugs, batches, sales, alerts, push tokens |
| Monitor | `GET /admin/alerts?tier=&type=&q=&page=` | Open alerts from every pharmacy (with pharmacy), most urgent first, chip `counts` |
| Activity | `GET /admin/activity?group=&userId=&page=` | `group` all / access / stock / sale / admin, newest first, chip `counts` |

**Effects on pharmacy accounts** (in `middleware/auth.js`): a suspended account gets `403 ACCOUNT_SUSPENDED` on login and on
any request with an old token; a reset account gets `403 PASSWORD_CHANGE_REQUIRED` everywhere except `GET /auth/me` and
`POST /auth/change-password` until it picks a new password. Each token carries the account's `tokenVersion`; suspend, reset
and password changes bump it, which signs the account out everywhere.

**Activity log:** sign-ups, sign-ins, stock deliveries, sales, discards and every admin action are written to `ActivityLog`
(name and pharmacy are copied in, so entries survive account deletion). Old entries expire after `ACTIVITY_RETENTION_DAYS`.
Temporary passwords are never logged.

**Good to know**
- Admin numbers are computed in memory from each account's drugs, batches, last 6 weeks of sales and open alerts. That is fine
  for hundreds of pharmacies; for more, swap `services/adminStats.js#loadFootprint` for aggregation pipelines (same output).
- Account deletion is not transactional (MongoDB transactions need a replica set). It removes children first and the account
  last, so a failure leaves a still-existing account and the delete can be repeated.
- Login is rate limited per IP (30 per 15 minutes) like all `/auth` routes. There is no per-account lockout yet.
- The `location` field is optional at sign-up (the app's Register screen does not ask for it yet).

## How the rules from the documentation are implemented

- **Alert tiers:** Expired (past date), Critical (≤ 14 days), Warning (≤ 30), Upcoming (≤ 90), set in `src/config.js`.
  **Low stock** = sellable stock below the drug's `reorderLevel`. Expired batches never count as stock or get sold.
- **Alerts are stored records** (`AlertID, BatchID, DrugID, AlertType, AlertTier, Status, CreatedAt, ResolvedAt`).
  `services/alerts.js` opens them when something turns abnormal, raises the tier as expiry approaches, and resolves them
  when the problem disappears. It runs after every stock change and once a day (`ALERT_CRON`).
- **Push notifications** (Expo Notifications API) are sent when an alert opens or gets worse.
- **FEFO sales:** batches are used earliest-expiry first. MongoDB transactions need a replica set, so each deduction is a
  guarded atomic update (`quantity >= needed`) that is undone if stock changed meanwhile.
- **Forecast:** rolling 7-day buckets over 6 weeks → moving average (4 weeks) and exponential smoothing (α = 0.4) →
  weekly projection = average of the two → `suggested = projected × restock weeks + reorderLevel − stock in hand`.
- **Time zone:** "today" and week boundaries use `APP_TIMEZONE` (default `Africa/Lagos`), not the server's clock.
- **Security:** passwords hashed with bcrypt, JWT auth, input validation (zod), Helmet, rate limit on auth routes.
  Serve it over **HTTPS** in production (Render, Railway, Fly and most hosts terminate TLS for you; `trust proxy` is on).
- **Data isolation:** each account sees only its own drugs, suppliers, batches, sales and alerts (Drug → User in the ERD).
  Sharing one pharmacy between several staff accounts would need an invite/pharmacy entity the ERD does not have yet.

## Connecting the app

The mobile app currently runs on mock data (pharmacist screens in `InventoryContext.js`, admin screens in `AdminContext.js`). To switch it over, replace the actions in the app's
`src/context/InventoryContext.js` with calls to this API and set the base URL (for a phone on the same Wi-Fi, use the
computer's LAN address, e.g. `http://192.168.1.20:4000/api`). Field names already match the ERD, so screens need little change.
