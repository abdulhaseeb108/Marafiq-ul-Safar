import type { Request, RequestHandler } from 'express';
import { rateLimited } from './http-error.js';
import { FailureLimiter } from './rate-limiter.js';

interface Window {
  max: number;
  windowMs: number;
}

/** Limits on the public API, per client IP (docs/02 section 4). */
export interface PublicRateLimits {
  /** Every request to /public. docs/02: 60 per minute. */
  general: Window;
  /** Inquiries accepted. docs/02: 5 per hour. */
  inquiries: Window;
  /** Quote links that were not found: slows down anyone guessing tokens. */
  quoteMisses: Window;
}

export const DEFAULT_PUBLIC_RATE_LIMITS: PublicRateLimits = {
  general: { max: 60, windowMs: 60 * 1000 },
  inquiries: { max: 5, windowMs: 60 * 60 * 1000 },
  quoteMisses: { max: 20, windowMs: 15 * 60 * 1000 },
};

export interface PublicLimitHandlers {
  general: RequestHandler;
  inquiry: RequestHandler;
  quoteLink: RequestHandler;
}

const pass: RequestHandler = (_req, _res, next) => next();
const clientKey = (req: Request) => req.ip ?? 'unknown';
const limiterFor = (window: Window) =>
  new FailureLimiter({ maxFailures: window.max, windowMs: window.windowMs });

/**
 * Builds the middleware. `null` turns the limits off (tests that send many
 * requests); production always passes limits (config/app-config.ts).
 *
 * Counters are in memory, which is right for the single API process this
 * project runs (docs/DEPLOY.md). A second process would need a shared store.
 */
export function makePublicLimits(limits: PublicRateLimits | null): PublicLimitHandlers {
  if (!limits) return { general: pass, inquiry: pass, quoteLink: pass };
  const general = limiterFor(limits.general);
  const inquiries = limiterFor(limits.inquiries);
  const quoteMisses = limiterFor(limits.quoteMisses);

  /** Refuses when the key is over the limit; counts the request once it has answered. */
  const countWhen =
    (limiter: FailureLimiter, counts: (status: number) => boolean): RequestHandler =>
    (req, res, next) => {
      const key = clientKey(req);
      const wait = limiter.retryAfterSeconds(key);
      if (wait > 0) {
        next(rateLimited(wait));
        return;
      }
      res.on('finish', () => {
        if (counts(res.statusCode)) limiter.recordFailure(key);
      });
      next();
    };

  return {
    general: (req, _res, next) => {
      const wait = general.take(clientKey(req));
      next(wait > 0 ? rateLimited(wait) : undefined);
    },
    // Only accepted inquiries count, so a traveler fixing a typo is not locked out.
    inquiry: countWhen(inquiries, (status) => status === 201),
    quoteLink: countWhen(quoteMisses, (status) => status === 404),
  };
}
