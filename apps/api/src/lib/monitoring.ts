import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

/**
 * Error reporting with Sentry (docs/01 section 9). Off unless SENTRY_DSN is
 * set. No automatic request capture: only errors the API reports itself, plus
 * crashes. Every event is scrubbed before it leaves the server: no request,
 * no user, no breadcrumbs, and no error messages (a message can quote a value
 * from the request). What remains is the error class, the stack and the tags.
 */
let enabled = false;

export interface MonitoringOptions {
  dsn?: string;
  environment: string;
  release?: string;
}

export function initMonitoring(options: MonitoringOptions): boolean {
  if (!options.dsn) return false;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    // Collect nothing about the request or the user; beforeSend scrubs again.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    tracesSampleRate: 0,
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
  });
  enabled = true;
  return true;
}

/** Removes everything that could hold personal data or a quote token. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.contexts;
  if (event.message) event.message = '[redacted]';
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = '[redacted]';
  }
  return event;
}

/** Reports an unexpected error. Tags must be ids or route patterns only. */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  if (!enabled) return;
  Sentry.captureException(error, { tags });
}

/** Sends queued events before the process exits. */
export async function closeMonitoring(): Promise<void> {
  if (!enabled) return;
  enabled = false;
  await Sentry.close(2000);
}
