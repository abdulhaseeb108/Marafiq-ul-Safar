import type { ApiError } from '@marafiq/shared';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { LogEmail, type EmailAdapter } from './adapters/email/email.js';
import { MemoryStorage, type StorageAdapter } from './adapters/storage/storage.js';
import type { ExtractionAdapter } from './adapters/extraction/extraction.js';
import type { AppConfig } from './config/app-config.js';
import type { AdminRoute } from './lib/admin-route.js';
import { HttpError, conflict, isDuplicateKeyError } from './lib/http-error.js';
import { FailureLimiter } from './lib/rate-limiter.js';
import { auditAdminRoutes } from './modules/audit/audit.routes.js';
import { makeAuthMiddleware } from './modules/auth/auth.middleware.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { DEFAULT_DOCUMENT_PARSER_LIMITS } from './modules/document-intelligence/document-parser-limits.js';
import { documentIntelligenceAdminRoutes } from './modules/document-intelligence/document-intelligence.routes.js';
import { flightEstimatesAdminRoutes } from './modules/flight-estimates/flight-estimates.routes.js';
import { fxAdminRoutes } from './modules/fx/fx.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { hotelsAdminRoutes } from './modules/hotels/hotels.routes.js';
import { leadsAdminRoutes } from './modules/leads/leads.routes.js';
import { createPublicRouter } from './modules/public/public.routes.js';
import { rateSheetAdminRoutes } from './modules/rate-sheets/rate-sheets.routes.js';
import { settingsAdminRoutes } from './modules/settings/settings.routes.js';
import { suppliersAdminRoutes } from './modules/suppliers/suppliers.routes.js';
import { usersAdminRoutes } from './modules/users/users.routes.js';

const ADMIN_PREFIX = '/api/v1/admin';

/** Outside services the API talks to. Tests pass in-memory stand-ins. */
export interface AppDeps {
  storage: StorageAdapter;
  /** Absent when no ANTHROPIC_API_KEY is configured. */
  extraction?: ExtractionAdapter;
  /** True in tests: wait for background work before answering. */
  inlineJobs: boolean;
  email: EmailAdapter;
}

/** Every /admin route in the API. Add new modules' routes here. */
function buildAdminRoutes(
  config: Pick<
    AppConfig,
    | 'maxUploadBytes'
    | 'documentParserLimits'
    | 'maxConcurrentDocumentUploads'
    | 'publicSiteUrl'
    | 'staffNotifyEmail'
  >,
  deps: AppDeps,
): AdminRoute[] {
  return [
    ...documentIntelligenceAdminRoutes({
      storage: deps.storage,
      limits: config.documentParserLimits,
      maxConcurrentUploads: config.maxConcurrentDocumentUploads,
    }),
    ...usersAdminRoutes,
    ...auditAdminRoutes,
    ...suppliersAdminRoutes,
    ...hotelsAdminRoutes,
    ...settingsAdminRoutes,
    ...fxAdminRoutes,
    ...flightEstimatesAdminRoutes,
    ...rateSheetAdminRoutes({ ...deps, maxUploadBytes: config.maxUploadBytes }),
    ...leadsAdminRoutes({ email: deps.email, config }),
  ];
}

/** "METHOD /path" for each admin route; the permission test checks this list. */
export function listAdminRoutes(): string[] {
  const routes = buildAdminRoutes(
    {
      maxUploadBytes: 1,
      documentParserLimits: DEFAULT_DOCUMENT_PARSER_LIMITS,
      maxConcurrentDocumentUploads: 2,
      publicSiteUrl: 'http://localhost',
    },
    { storage: new MemoryStorage(), inlineJobs: true, email: new LogEmail() },
  );
  return routes.map((r) => `${r.method.toUpperCase()} ${ADMIN_PREFIX}${r.path}`);
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
    // Errors raised by the upload parser.
    if (err instanceof Error && err.name === 'MulterError') {
      const tooLarge = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      const body: ApiError = {
        error: tooLarge
          ? { code: 'file_too_large', message: 'The file is larger than 20 MB.' }
          : { code: 'invalid_upload', message: 'The upload could not be read.' },
      };
      res.status(tooLarge ? 413 : 400).json(body);
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
    // A unique index refused a write that a service did not expect to collide:
    // two requests at the same moment. A conflict to retry, not a server fault.
    // (The driver's message names the duplicated value, so it is never sent on.)
    if (isDuplicateKeyError(err)) {
      const { status, code, message } = conflict();
      const body: ApiError = { error: { code, message } };
      res.status(status).json(body);
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
export function createApp(options: { config: AppConfig; deps?: Partial<AppDeps> }): Express {
  const { config } = options;
  const deps: AppDeps = {
    storage: options.deps?.storage ?? new MemoryStorage(),
    extraction: options.deps?.extraction,
    inlineJobs: options.deps?.inlineJobs ?? false,
    email: options.deps?.email ?? new LogEmail(),
  };
  const adminRoutes = buildAdminRoutes(config, deps);
  const limiter = new FailureLimiter(config.loginLimit);
  const { requireAuth, requireRole } = makeAuthMiddleware(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Public
  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/public', createPublicRouter({ email: deps.email, config }));
  app.use('/api/v1/auth', createAuthRouter({ config, limiter }, requireAuth));

  // Staff only: each route is mounted behind sign-in and its role check.
  for (const route of adminRoutes) {
    app[route.method](
      `${ADMIN_PREFIX}${route.path}`,
      requireAuth,
      requireRole(...route.roles),
      ...(route.before ?? []),
      route.handler,
    );
  }
  // Anything else under /admin still requires sign-in before it 404s.
  app.use(ADMIN_PREFIX, requireAuth, notFoundHandler);

  app.use(notFoundHandler);
  app.use(makeErrorHandler(config));
  return app;
}
