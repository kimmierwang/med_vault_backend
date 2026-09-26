import dotenv from 'dotenv';
import fs from 'fs';

// Load default `.env` first, then override with `.env.local` when present.
dotenv.config();
if (fs.existsSync('.env.local')) dotenv.config({ path: '.env.local' });

const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT) || 4000,
  mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/medvault',
  jwtSecret: env.JWT_SECRET || (env.NODE_ENV === 'production' ? undefined : 'dev-only-secret-change-me'),
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: Number(env.BCRYPT_ROUNDS) || 10,
  // Day boundaries ("today", "days to expiry", weekly sales buckets) are worked out in this zone.
  timezone: env.APP_TIMEZONE || 'Africa/Lagos',
  corsOrigin: env.CORS_ORIGIN || '*',
  passwordMinLength: Number(env.PASSWORD_MIN_LENGTH) || 6,
  // Daily job that re-checks expiry tiers (batches move to a worse tier as days pass).
  alertCron: env.ALERT_CRON || '0 6 * * *',
  enableCron: env.ENABLE_CRON !== 'false',
  pushEnabled: env.PUSH_ENABLED !== 'false',
  expoAccessToken: env.EXPO_ACCESS_TOKEN || undefined,

  // ---- Administrator (exactly one account may exist) ----
  // If no admin exists yet, the server creates one at start-up from these (never overwrites an existing admin).
  // Or run `npm run create-admin`. Use a strong password and remove it from the environment afterwards.
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase() || undefined,
  adminPassword: env.ADMIN_PASSWORD || undefined,
  adminName: env.ADMIN_NAME || 'MedVault Administrator',
  adminId: (env.ADMIN_ID || 'ADMIN-001').trim().toUpperCase(),
  adminPasswordMinLength: Number(env.ADMIN_PASSWORD_MIN_LENGTH) || 10,
  // Admin console thresholds and log retention
  newUserDays: 7,            // "New" = signed up in the last 7 days
  inactiveDays: 30,          // "Inactive" = no activity for 30+ days
  activityRetentionDays: Number(env.ACTIVITY_RETENTION_DAYS) || 180,

  // Fixed system rules from the documentation (§3.4.3.2 / §3.4.5)
  tiers: { critical: 14, warning: 30, upcoming: 90 },
  forecast: { historyWeeks: 6, maWindow: 4, alpha: 0.4, defaultLeadTimeWeeks: 2 },
};

if (!config.jwtSecret) throw new Error('JWT_SECRET must be set when NODE_ENV=production');
