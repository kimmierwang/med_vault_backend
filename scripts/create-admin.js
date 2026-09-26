// Creates THE administrator (there can only ever be one). Run on the server, not through the API:
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-Passw0rd' npm run create-admin
// Optional: ADMIN_NAME, ADMIN_ID (default ADMIN-001).
// Lost the password? The same command with --reset-password sets a new one for the existing admin.
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Admin } from '../src/models/index.js';
import { createAdmin, setAdminPassword } from '../src/services/admin.js';

const reset = process.argv.includes('--reset-password');
const { adminEmail, adminPassword } = config;

await mongoose.connect(config.mongoUri);
try {
  await Admin.init();
  const existing = await Admin.findOne();
  if (existing && !reset) {
    console.error(`An administrator already exists (${existing.email}). There can only be one.\nTo set a new password for it, run again with --reset-password.`);
    process.exitCode = 1;
  } else if (existing && reset) {
    if (!adminPassword) throw new Error('Set ADMIN_PASSWORD to the new password');
    await setAdminPassword(existing, adminPassword);
    console.log(`Password updated for ${existing.email}. All of its sessions were ended.`);
  } else {
    if (!adminEmail || !adminPassword) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
    const admin = await createAdmin({ name: config.adminName, email: adminEmail, adminId: config.adminId, password: adminPassword });
    console.log(`Administrator created: ${admin.email} (ID ${admin.adminId}). Sign in through the app's normal login screen.`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
