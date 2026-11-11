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
