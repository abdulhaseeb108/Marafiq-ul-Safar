import type { ApiError } from '@marafiq/shared';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import type { AppConfig } from './config/app-config.js';
import type { AdminRoute } from './lib/admin-route.js';
import { HttpError } from './lib/http-error.js';
import { FailureLimiter } from './lib/rate-limiter.js';
import { auditAdminRoutes } from './modules/audit/audit.routes.js';
import { makeAuthMiddleware } from './modules/auth/auth.middleware.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { flightEstimatesAdminRoutes } from './modules/flight-estimates/flight-estimates.routes.js';
import { fxAdminRoutes } from './modules/fx/fx.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { hotelsAdminRoutes } from './modules/hotels/hotels.routes.js';
import { publicRouter } from './modules/public/public.routes.js';
import { settingsAdminRoutes } from './modules/settings/settings.routes.js';
import { suppliersAdminRoutes } from './modules/suppliers/suppliers.routes.js';
import { usersAdminRoutes } from './modules/users/users.routes.js';

const ADMIN_PREFIX = '/api/v1/admin';

/** Every /admin route in the API. Add new modules' routes here. */
const adminRoutes: AdminRoute[] = [
  ...usersAdminRoutes,
  ...auditAdminRoutes,
  ...suppliersAdminRoutes,
  ...hotelsAdminRoutes,
  ...settingsAdminRoutes,
  ...fxAdminRoutes,
  ...flightEstimatesAdminRoutes,
];

/** "METHOD /path" for each admin route; the permission test checks this list. */
export function listAdminRoutes(): string[] {
  return adminRoutes.map((r) => `${r.method.toUpperCase()} ${ADMIN_PREFIX}${r.path}`);
}

const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ApiError = { error: { code: 'not_found', message: 'Route not found' } };
  res.status(404).json(body);
};

function makeErrorHandler(config: AppConfig): ErrorRequestHandler {
  // Express identifies error handlers by their four arguments.
  return (err: unknown, _req, res, _next) => {
    if (err instanceof HttpError) {
      if (err.headers) res.set(err.headers);
      const body: ApiError = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
        },
      };
      res.status(err.status).json(body);
      return;
    }
    // Errors raised by express.json() for bad or oversized bodies.
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.parse.failed' || type === 'entity.too.large') {
      const tooLarge = type === 'entity.too.large';
      const body: ApiError = {
        error: {
          code: tooLarge ? 'payload_too_large' : 'invalid_json',
          message: tooLarge ? 'Request body is too large' : 'Request body is not valid JSON',
        },
      };
      res.status(tooLarge ? 413 : 400).json(body);
      return;
    }
    // Log the error name only: no request bodies or personal data in logs.
    if (config.nodeEnv !== 'test') {
      console.error('Unhandled error:', err instanceof Error ? err.name : 'unknown');
    }
    const body: ApiError = { error: { code: 'internal_error', message: 'Something went wrong' } };
    res.status(500).json(body);
  };
}

/** Builds the Express app without listening, so tests can use it directly. */
export function createApp(options: { config: AppConfig }): Express {
  const { config } = options;
  const limiter = new FailureLimiter(config.loginLimit);
  const { requireAuth, requireRole } = makeAuthMiddleware(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Public
  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/public', publicRouter);
  app.use('/api/v1/auth', createAuthRouter({ config, limiter }, requireAuth));

  // Staff only: each route is mounted behind sign-in and its role check.
  for (const route of adminRoutes) {
    app[route.method](
      `${ADMIN_PREFIX}${route.path}`,
      requireAuth,
      requireRole(...route.roles),
      route.handler,
    );
  }
  // Anything else under /admin still requires sign-in before it 404s.
  app.use(ADMIN_PREFIX, requireAuth, notFoundHandler);

  app.use(notFoundHandler);
  app.use(makeErrorHandler(config));
  return app;
}
