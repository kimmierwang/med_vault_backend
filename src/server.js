import mongoose from 'mongoose';
import cron from 'node-cron';
import { config } from './config.js';
import { createApp } from './app.js';
import { reconcileAll } from './services/alerts.js';
import { ensureAdmin } from './services/admin.js';

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log(`MongoDB connected (${mongoose.connection.name})`);

  // There is exactly one administrator. Create it from ADMIN_EMAIL / ADMIN_PASSWORD if none exists yet.
  const admin = await ensureAdmin();
  if (admin.created) console.log(`Administrator account created for ${admin.email}. Remove ADMIN_PASSWORD from the environment now.`);
  else if (!admin.exists) console.warn('No administrator account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run create-admin');

  const app = createApp();
  const server = app.listen(config.port, () => console.log(`MedVault API listening on port ${config.port} (${config.env})`));

  if (config.enableCron) {
    cron.schedule(config.alertCron, async () => {
      try {
        const n = await reconcileAll();
        console.log(`Daily alert check done for ${n} pharmacy account(s)`);
      } catch (err) {
        console.error('Daily alert check failed:', err);
      }
    }, { timezone: config.timezone });
  }

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
