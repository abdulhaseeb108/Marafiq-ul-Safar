import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { configureLogger, captureLogs, errorName, log } from './logger.js';
import { initMonitoring, scrubEvent } from './monitoring.js';

describe('Sentry event scrubbing', () => {
  it('removes request, user, breadcrumbs and messages; keeps the error class and stack', () => {
    const event = {
      message: 'Phone 03001234567 already exists',
      request: { url: 'https://site.test/api/v1/public/quotes/SECRET', cookies: { a: 'b' } },
      user: { ip_address: '198.51.100.1' },
      breadcrumbs: [{ message: 'GET /quotes/SECRET' }],
      extra: { body: { phone: '03001234567' } },
      contexts: { trace: {} },
      tags: { route: '/api/v1/public/quotes/:token' },
      exception: {
        values: [
          {
            type: 'MongoServerError',
            value: 'E11000 duplicate key { phone: "03001234567" }',
            stacktrace: { frames: [{ function: 'createInquiry' }] },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain('03001234567');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('198.51.100.1');
    expect(scrubbed.exception?.values?.[0]?.type).toBe('MongoServerError');
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]?.function).toBe(
      'createInquiry',
    );
    expect(scrubbed.tags).toEqual({ route: '/api/v1/public/quotes/:token' });
  });

  it('stays off without a DSN', () => {
    expect(initMonitoring({ environment: 'test' })).toBe(false);
  });
});

describe('logger', () => {
  it('writes one JSON object per line in production format', () => {
    const lines: string[] = [];
    const restore = captureLogs((_level, line) => lines.push(line));
    configureLogger({ json: true });
    try {
      log.warn('index problem', {
        problem: 'Lead: MongoServerError',
        count: 2,
        skipped: undefined,
      });
    } finally {
      restore();
    }
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: 'warn', msg: 'index problem', count: 2 });
    expect(entry).not.toHaveProperty('skipped');
    expect(typeof entry.time).toBe('string');
  });

  it('reports error class names, not messages', () => {
    expect(errorName(new TypeError('secret value'))).toBe('TypeError');
    expect(errorName('a string')).toBe('unknown');
  });
});
