import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { Admin, User, ROLES } from '../models/index.js';
import { presentAdmin, presentUser } from '../models/present.js';
import { signAdminToken, signUserToken, requireAuthAllowPasswordChange } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, asyncHandler } from '../utils/http.js';
import { logActivity } from '../services/activity.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  staffId: z.string().trim().min(2, 'Enter your staff ID').transform((s) => s.toUpperCase()),
  role: z.enum(ROLES),
  pharmacyName: z.string().trim().min(2, 'Enter the pharmacy name'),
  location: z.string().trim().max(120).optional().default(''),
  password: z.string().min(config.passwordMinLength, `Use at least ${config.passwordMinLength} characters`).max(128),
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or staff ID'),
  password: z.string().min(1, 'Enter your password'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(config.passwordMinLength, `Use at least ${config.passwordMinLength} characters`).max(128),
});

router.post('/register', validate(registerSchema), asyncHandler(async (req, res) => {
  const { password, ...rest } = req.body;
  // The administrator's email and ID are reserved: sign-up can never create (or impersonate) a second admin.
  const reserved = await Admin.findOne({ $or: [{ email: rest.email }, { adminId: rest.staffId }] }, '_id').lean();
  if (reserved) throw new HttpError(409, 'That email or staff ID is reserved');
  const clash = await User.findOne({ $or: [{ email: rest.email }, { staffId: rest.staffId }] }).lean();
  if (clash) {
    throw new HttpError(409, clash.email === rest.email ? 'An account with this email already exists' : 'This staff ID is already registered');
  }
  const user = await User.create({ ...rest, passwordHash: await bcrypt.hash(password, config.bcryptRounds) });
  await logActivity({ user, type: 'signup', message: 'Created an account' });
  res.status(201).json({ token: signUserToken(user), user: presentUser(user), isAdmin: false });
}));

// One login for everybody (documentation §4.1.0): email OR staff ID. If the identifier belongs to THE
// administrator the response has `isAdmin: true` and an admin token; the app then opens the admin console.
router.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  const isEmail = identifier.includes('@');

  const admin = await Admin.findOne(isEmail ? { email: identifier.toLowerCase() } : { adminId: identifier.toUpperCase() });
  if (admin) {
    if (!(await bcrypt.compare(password, admin.passwordHash))) throw new HttpError(401, 'Incorrect email/staff ID or password');
    await Admin.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
    await logActivity({ actor: 'admin', type: 'admin', message: 'Administrator signed in' });
    return res.json({ token: signAdminToken(admin), user: presentAdmin(admin), isAdmin: true });
  }

  const user = await User.findOne(isEmail ? { email: identifier.toLowerCase() } : { staffId: identifier.toUpperCase() });
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw new HttpError(401, 'Incorrect email/staff ID or password');
  // Only tell the person their account is suspended once they proved it is theirs.
  if (user.status === 'suspended') throw new HttpError(403, 'This account is suspended. Contact the MedVault administrator.', undefined, 'ACCOUNT_SUSPENDED');
  const now = new Date();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, lastActiveAt: now } });
  await logActivity({ user, type: 'login', message: 'Signed in' });
  res.json({ token: signUserToken(user), user: presentUser(user), isAdmin: false, mustChangePassword: !!user.mustChangePassword });
}));

router.get('/me', requireAuthAllowPasswordChange, (req, res) => res.json({ user: presentUser(req.user) }));

// Choose a new password (required after an admin reset). Ends all other sessions and returns a fresh token.
router.post('/change-password', requireAuthAllowPasswordChange, validate(changePasswordSchema), asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id);
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw new HttpError(401, 'Your current password is incorrect');
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password you have not used just now');
  user.passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  user.mustChangePassword = false;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  res.json({ token: signUserToken(user), user: presentUser(user) });
}));

export default router;
