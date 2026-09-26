import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { Admin, User } from '../models/index.js';
import { HttpError, asyncHandler } from '../utils/http.js';

// Two kinds of token, told apart by the `role` claim:
//   role 'user'  -> a pharmacy account (all the stock routes)
//   role 'admin' -> THE administrator (only /api/admin/*)
// `tv` is the account's tokenVersion. Bumping it (suspend, password reset/change) signs the account out everywhere.
export const signUserToken = (user) => jwt.sign({ sub: String(user._id), role: 'user', tv: user.tokenVersion || 0 }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
export const signAdminToken = (admin) => jwt.sign({ sub: String(admin._id), role: 'admin', tv: admin.tokenVersion || 0 }, config.jwtSecret, { expiresIn: '12h' }); // shorter session for the admin
export const signToken = signUserToken;

function readToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Authentication required');
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
}

const TOUCH_EVERY_MS = 5 * 60 * 1000; // "last active" is refreshed at most every 5 minutes

async function loadUser(req, { allowPasswordChange }) {
  const payload = readToken(req);
  if (payload.role === 'admin') throw new HttpError(403, 'The administrator account can only use the admin console', undefined, 'ADMIN_TOKEN');
  const user = await User.findById(payload.sub).lean();
  if (!user) throw new HttpError(401, 'Account no longer exists');
  if ((payload.tv || 0) !== (user.tokenVersion || 0)) throw new HttpError(401, 'Your session has ended. Please sign in again.', undefined, 'SESSION_ENDED');
  if (user.status === 'suspended') throw new HttpError(403, 'This account is suspended. Contact the MedVault administrator.', undefined, 'ACCOUNT_SUSPENDED');
  if (user.mustChangePassword && !allowPasswordChange) throw new HttpError(403, 'You must choose a new password before continuing', undefined, 'PASSWORD_CHANGE_REQUIRED');
  if (!user.lastActiveAt || Date.now() - user.lastActiveAt.getTime() > TOUCH_EVERY_MS) {
    User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
  }
  req.user = user;
  req.userIds = [user._id];
}

// Every stock route requires a logged-in, active pharmacy account. `req.userIds` is the set of users whose
// data this account may see. Today that is just the account itself (each account = one pharmacy, as in the
// ERD where Drug points to a User); staff sharing would extend it here.
export const requireAuth = asyncHandler(async (req, _res, next) => {
  await loadUser(req, { allowPasswordChange: false });
  next();
});

// Same, but usable while a password change is still pending (profile + change-password only).
export const requireAuthAllowPasswordChange = asyncHandler(async (req, _res, next) => {
  await loadUser(req, { allowPasswordChange: true });
  next();
});

// Only THE administrator gets through.
export const requireAdmin = asyncHandler(async (req, _res, next) => {
  const payload = readToken(req);
  if (payload.role !== 'admin') throw new HttpError(403, 'Administrator access required', undefined, 'ADMIN_ONLY');
  const admin = await Admin.findById(payload.sub).lean();
  if (!admin) throw new HttpError(401, 'Administrator account not found');
  if ((payload.tv || 0) !== (admin.tokenVersion || 0)) throw new HttpError(401, 'Your session has ended. Please sign in again.', undefined, 'SESSION_ENDED');
  req.admin = admin;
  next();
});
