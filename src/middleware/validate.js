import { HttpError } from '../utils/http.js';

// validate(zodSchema, 'body' | 'query' | 'params') -> replaces req[source] with the parsed value.
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return next(new HttpError(400, 'Validation failed', details));
  }
  req[source] = result.data;
  return next();
};
