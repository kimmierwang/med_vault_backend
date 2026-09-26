import { ActivityLog } from '../models/index.js';

// Writes one line of the system activity log (the admin's Activity tab).
// Logging must never break the request that triggered it, so failures are swallowed.
//   user  = the pharmacy account the entry is about (or null)
//   actor = who did it: 'user' | 'admin' | 'system'
export async function logActivity({ user = null, type, message, actor = 'user' }) {
  try {
    await ActivityLog.create({
      userId: user?._id ?? null,
      userName: user?.name ?? (actor === 'admin' ? 'Administrator' : ''),
      pharmacyName: user?.pharmacyName ?? '',
      actor, type, message,
    });
  } catch (err) {
    console.error('Could not write activity log:', err.message);
  }
}
