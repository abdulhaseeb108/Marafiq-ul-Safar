import type { ApiError } from '@marafiq/shared';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { healthRouter } from './modules/health/health.routes.js';

const notFound: RequestHandler = (_req, res) => {
  const body: ApiError = { error: { code: 'not_found', message: 'Route not found' } };
  res.status(404).json(body);
};

// Express identifies error handlers by their four arguments.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  // Log the error name only: no request bodies or personal data in logs.
  console.error('Unhandled error:', err instanceof Error ? err.name : 'unknown');
  const body: ApiError = { error: { code: 'internal_error', message: 'Something went wrong' } };
  res.status(500).json(body);
};

/** Builds the Express app without listening, so tests can use it directly. */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/v1/health', healthRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
