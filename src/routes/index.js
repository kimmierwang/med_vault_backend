import { Router } from 'express';
import auth from './auth.js';
import drugs from './drugs.js';
import suppliers from './suppliers.js';
import batches from './batches.js';
import sales from './sales.js';
import alerts from './alerts.js';
import forecast from './forecast.js';
import dashboard from './dashboard.js';
import exportRoutes from './export.js';
import push from './push.js';
import admin from './admin.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../utils/http.js';

const api = Router();

api.use('/auth', auth);

// The administrator's own API (has its own guard: only THE admin token is accepted).
api.use('/admin', admin);
// Anything else under /admin is a 404 — it must never fall through to the pharmacy routes below.
api.use('/admin', (req, _res, next) => next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`)));

// Everything below needs a logged-in user.
api.use(requireAuth);
api.use('/dashboard', dashboard);
api.use('/drugs', drugs);
api.use('/suppliers', suppliers);
api.use('/batches', batches);
api.use('/sales', sales);
api.use('/alerts', alerts);
api.use('/forecast', forecast);
api.use('/export', exportRoutes);
api.use('/push', push);

export default api;
