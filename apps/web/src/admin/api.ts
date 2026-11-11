/**
 * Fetch wrapper for the staff API. Auth lives in httpOnly cookies, so there is
 * no token handling here: the browser sends the cookies, and on a 401 we try
 * one silent refresh before giving up.
 */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const BASE = '/api/v1';

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  /** Set false for the auth endpoints themselves. */
  retryOn401?: boolean;
}

async function send(path: string, options: Options): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && options.retryOn401 !== false) {
    const refreshed = await send('/auth/refresh', { method: 'POST' });
    if (refreshed.ok) res = await send(path, options);
  }
  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (
      data as {
        error?: { code?: string; message?: string; fields?: Record<string, string> };
      } | null
    )?.error;
    throw new ApiRequestError(
      res.status,
      error?.code ?? 'unknown',
      error?.message ?? 'Request failed',
      error?.fields,
    );
  }
  return data as T;
}
