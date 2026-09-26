import { HttpError } from '../utils/http.js';
import { config } from '../config.js';

export const notFound = (req, _res, next) => next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, details: err.details, code: err.appCode } });
  }
  if (err?.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return res.status(400).json({ error: { message: 'Validation failed', details } });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: { message: 'That record already exists' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Request body is not valid JSON' } });
  }
  console.error(err);
  return res.status(500).json({ error: { message: config.env === 'production' ? 'Something went wrong' : err.message } });
};
