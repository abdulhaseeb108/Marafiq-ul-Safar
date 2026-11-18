import type { RequestHandler } from 'express';

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';
const ALLOWED_HEADERS = 'Content-Type';

/**
 * CORS allow-list (docs/05 decision 45). The standard deployment serves the
 * web app and the API on one origin, so browsers never ask for CORS and this
 * does nothing. It exists for a split deployment: only origins listed in
 * WEB_ORIGIN may call the API from a browser, with cookies.
 *
 * Requests from other origins get no CORS headers, so the browser refuses to
 * hand them the response. Session cookies are SameSite=Strict as well.
 */
export function corsAllowList(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) {
      next();
      return;
    }
    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}
