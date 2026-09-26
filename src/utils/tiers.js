import { config } from '../config.js';

// Alert tiers (documentation §3.4.3.2): Upcoming, Warning, Critical, Expired.
export const TIER_RANK = { expired: 0, critical: 1, warning: 2, upcoming: 3, ok: 4 };

export function getTier(days) {
  if (days < 0) return 'expired';
  if (days <= config.tiers.critical) return 'critical';
  if (days <= config.tiers.warning) return 'warning';
  if (days <= config.tiers.upcoming) return 'upcoming';
  return 'ok';
}
