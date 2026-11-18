/** An error with an HTTP status, rendered as `{error:{code,message,fields?}}`. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthenticated = () =>
  new HttpError(401, 'unauthenticated', 'Please sign in to continue');

export const forbidden = () =>
  new HttpError(403, 'forbidden', 'You do not have permission to do this');

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);

export const rateLimited = (retryAfterSeconds: number) =>
  new HttpError(429, 'rate_limited', 'Too many attempts. Please try again later.', undefined, {
    'Retry-After': String(retryAfterSeconds),
  });

/** MongoDB's "duplicate key": a unique index refused a write (E11000). */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/** Two requests changed the same thing at the same moment; the other one won. */
export const conflict = () =>
  new HttpError(
    409,
    'conflict',
    'This was changed by someone else at the same time. Reload and try again.',
  );
