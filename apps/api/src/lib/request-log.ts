import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { log } from './logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Random id for this request; also sent back as the X-Request-Id header. */
    requestId?: string;
    /** Where the matched router is mounted (Express resets baseUrl on the way out). */
    routeBase?: string;
  }
}

/**
 * The route pattern, e.g. `/api/v1/public/quotes/:token`. Never the real URL:
 * customer quote links carry their secret token in the path.
 */
export function routeLabel(req: Request): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  return typeof pattern === 'string' ? `${req.routeBase ?? req.baseUrl}${pattern}` : 'unmatched';
}

/** Put in front of a mounted router so its prefix is still known when the request is logged. */
export const rememberBase: RequestHandler = (req, _res, next) => {
  req.routeBase = req.baseUrl;
  next();
};

/** One log line per request: id, method, route pattern, status and duration. */
export const requestLog: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const route = routeLabel(req);
    // Uptime checks hit the health route every few seconds; log only failures.
    if (route.startsWith('/api/v1/health') && res.statusCode < 400) return;
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const fields = { requestId, method: req.method, route, status: res.statusCode, ms };
    if (res.statusCode >= 500) log.error('request', fields);
    else log.info('request', fields);
  });
  next();
};
