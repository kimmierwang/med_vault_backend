import mongoose from 'mongoose';

export class HttpError extends Error {
  constructor(status, message, details, code) {
    super(message);
    this.status = status;
    this.details = details;
    this.appCode = code; // machine-readable reason the app can act on, e.g. ACCOUNT_SUSPENDED
  }
}

// Express 4 does not catch rejected promises by itself.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function toObjectId(id, label = 'id') {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(400, `Invalid ${label}`);
  return new mongoose.Types.ObjectId(id);
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
