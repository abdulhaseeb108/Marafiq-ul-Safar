import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from './http-error.js';

export const ORIGIN_SECRET_HEADER = 'x-origin-secret';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * When ORIGIN_PROXY_SECRET is set, the API answers only requests that came
 * through the site's own proxy (docs/DEPLOY.md), which adds this header. A
 * request sent straight to the API host is refused, so nobody can skip the
 * proxy and choose their own client IP for the rate limits.
 *
 * The health route stays open so the host's health check keeps working.
 */
export function requireOriginSecret(secret: string | undefined): RequestHandler {
  if (!secret) return (_req, _res, next) => next();
  const expected = digest(secret);
  return (req, _res, next) => {
    if (req.path === '/api/v1/health' || req.path.startsWith('/api/v1/health/')) {
      next();
      return;
    }
    const given = req.headers[ORIGIN_SECRET_HEADER];
    // Compare fixed-length digests so the check takes the same time for any input.
    if (typeof given === 'string' && timingSafeEqual(digest(given), expected)) {
      next();
      return;
    }
    next(new HttpError(403, 'forbidden', 'You do not have permission to do this'));
  };
}
