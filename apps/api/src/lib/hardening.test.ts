/**
 * Phase 7 hardening (docs/04 Phase 7): security headers, CORS allow-list,
 * origin lock, public rate limits, spam check, input handling and request logs.
 */
import { CONSENT_TEXT_VERSION } from '@marafiq/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryEmail } from '../adapters/email/email.js';
import { MemoryStorage } from '../adapters/storage/storage.js';
import { createApp } from '../app.js';
import type { AppConfig } from '../config/app-config.js';
import { LeadModel } from '../modules/leads/lead.models.js';
import { makeApp, testConfig } from '../test/helpers.js';
import { captureLogs } from './logger.js';
import { ORIGIN_SECRET_HEADER } from './origin-lock.js';
import type { PublicRateLimits } from './public-limits.js';

const PUBLIC = '/api/v1/public';
const SITE = 'https://site.test';

function inquiry(overrides: Record<string, unknown> = {}) {
  return {
    source: 'visa',
    traveler: { name: 'Aisha Khan', phone: '0300 1234567', language: 'en' },
    notes: '',
    consent: { accepted: true, textVersion: CONSENT_TEXT_VERSION },
    ...overrides,
  };
}

function appWith(overrides: Partial<AppConfig>) {
  const email = new MemoryEmail();
  const app = createApp({
    config: testConfig(overrides),
    deps: { storage: new MemoryStorage(), inlineJobs: true, email },
  });
  return { app, email };
}

const tightLimits: PublicRateLimits = {
  general: { max: 3, windowMs: 60_000 },
  inquiries: { max: 1, windowMs: 3_600_000 },
  quoteMisses: { max: 2, windowMs: 900_000 },
};

describe('security headers', () => {
  it('are set on public, admin and error responses', async () => {
    const { app } = makeApp();
    for (const path of ['/api/v1/health', `${PUBLIC}/config`, '/api/v1/admin/users', '/nope']) {
      const res = await request(app).get(path);
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(res.headers['x-frame-options'], path).toBe('SAMEORIGIN');
      expect(res.headers['strict-transport-security'], path).toMatch(/max-age=\d+/);
      expect(res.headers['referrer-policy'], path).toBe('no-referrer');
      expect(res.headers['cross-origin-resource-policy'], path).toBe('same-site');
      expect(res.headers['x-powered-by'], path).toBeUndefined();
      expect(res.headers['x-request-id'], path).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('CORS allow-list', () => {
  it('grants listed origins only, with credentials', async () => {
    const { app } = makeApp({ webOrigins: [SITE] });
    const allowed = await request(app).get(`${PUBLIC}/config`).set('Origin', SITE);
    expect(allowed.headers['access-control-allow-origin']).toBe(SITE);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers.vary).toMatch(/Origin/);

    const other = await request(app).get(`${PUBLIC}/config`).set('Origin', 'https://evil.test');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for listed origins only', async () => {
    const { app } = makeApp({ webOrigins: [SITE] });
    const ok = await request(app)
      .options(`${PUBLIC}/inquiries`)
      .set('Origin', SITE)
      .set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-methods']).toContain('POST');
    expect(ok.headers['access-control-allow-headers']).toBe('Content-Type');

    const refused = await request(app)
      .options(`${PUBLIC}/inquiries`)
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does nothing when no origins are configured (same-origin deployment)', async () => {
    const { app } = makeApp();
    const res = await request(app).get(`${PUBLIC}/config`).set('Origin', SITE);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('origin lock (ORIGIN_PROXY_SECRET)', () => {
  const secret = 's'.repeat(40);

  it('refuses requests that did not come through the site proxy', async () => {
    const { app } = makeApp({ originProxySecret: secret });
    expect((await request(app).get(`${PUBLIC}/config`)).status).toBe(403);
    const wrong = await request(app).get(`${PUBLIC}/config`).set(ORIGIN_SECRET_HEADER, 'x');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('forbidden');
    const right = await request(app).get(`${PUBLIC}/config`).set(ORIGIN_SECRET_HEADER, secret);
    expect(right.status).toBe(200);
  });

  it('keeps the health check open for the host', async () => {
    const { app } = makeApp({ originProxySecret: secret });
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
  });
});

describe('public rate limits', () => {
  it('limits all public requests per client IP and says when to retry', async () => {
    const { app } = makeApp({ publicRateLimits: tightLimits });
    const get = (ip: string) => request(app).get(`${PUBLIC}/config`).set('X-Forwarded-For', ip);
    for (let i = 0; i < 3; i += 1) expect((await get('198.51.100.1')).status).toBe(200);
    const limited = await get('198.51.100.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another visitor is not affected.
    expect((await get('198.51.100.2')).status).toBe(200);
  });

  it('counts accepted inquiries only, so fixing a typo does not use up the limit', async () => {
    const { app } = makeApp({ publicRateLimits: tightLimits });
    const send = (body: object) =>
      request(app).post(`${PUBLIC}/inquiries`).set('X-Forwarded-For', '198.51.100.3').send(body);
    const typo = await send(inquiry({ traveler: { name: 'A', phone: '12', language: 'en' } }));
    expect(typo.status).toBe(400);
    expect((await send(inquiry())).status).toBe(201);
    const second = await send(inquiry({ notes: 'another trip' }));
    expect(second.status).toBe(429);
    expect(await LeadModel.countDocuments()).toBe(1);
  });

  it('slows down anyone guessing quote links', async () => {
    const { app } = makeApp({
      publicRateLimits: { ...tightLimits, general: { max: 100, windowMs: 60_000 } },
    });
    const guess = () =>
      request(app)
        .get(`${PUBLIC}/quotes/${'A'.repeat(43)}`)
        .set('X-Forwarded-For', '198.51.100.4');
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(404);
    const limited = await guess();
    expect(limited.status).toBe(429);
    expect(limited.headers['cache-control']).toBeUndefined();
  });
});

describe('inquiry spam check', () => {
  it('ignores a filled honeypot: same answer, nothing stored, no email', async () => {
    const { app, email } = appWith({ staffNotifyEmail: 'staff@agency.test' });
    const res = await request(app)
      .post(`${PUBLIC}/inquiries`)
      .send(
        inquiry({
          website: 'http://spam.example',
          traveler: {
            name: 'Bot',
            phone: '0300 1234567',
            email: 'bot@example.com',
            language: 'en',
          },
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^MSF-\d{4}-\d{6}$/);
    expect(res.body.duplicate).toBe(false);
    expect(await LeadModel.countDocuments()).toBe(0);
    expect(email.sent).toHaveLength(0);
  });

  it('ignores notes stuffed with links', async () => {
    const { app } = appWith({});
    const notes = 'cheap http://a.example http://b.example www.c.example';
    const res = await request(app).post(`${PUBLIC}/inquiries`).send(inquiry({ notes }));
    expect(res.status).toBe(201);
    expect(await LeadModel.countDocuments()).toBe(0);
  });

  it('accepts a real inquiry with an empty honeypot and a link or two', async () => {
    const { app } = appWith({});
    const notes = 'Hotel like https://hotel.example please';
    const res = await request(app)
      .post(`${PUBLIC}/inquiries`)
      .send(inquiry({ notes, website: '' }));
    expect(res.status).toBe(201);
    expect(await LeadModel.countDocuments()).toBe(1);
  });
});

describe('input handling', () => {
  it('rejects query operators where a value is expected', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`${PUBLIC}/inquiries`)
      .send(inquiry({ traveler: { name: 'A', phone: { $gt: '' }, language: 'en' } }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(await LeadModel.countDocuments()).toBe(0);
  });

  it('refuses request bodies over 100 KB', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`${PUBLIC}/inquiries`)
      .send(inquiry({ notes: 'x'.repeat(120_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });
});

describe('request logs', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it('log the route pattern, never the quote token or the client IP', async () => {
    const lines: string[] = [];
    restore = captureLogs((_level, line) => lines.push(line));
    const { app } = makeApp();
    const token = 'B'.repeat(43);
    await request(app).get(`${PUBLIC}/quotes/${token}`).set('X-Forwarded-For', '198.51.100.9');
    restore();
    restore = undefined;
    const line = lines.find((l) => l.includes('INFO request'));
    expect(line).toContain('/api/v1/public/quotes/:token');
    expect(line).toContain('status=404');
    expect(lines.join('\n')).not.toContain(token);
    expect(lines.join('\n')).not.toContain('198.51.100.9');
  });

  it('log unmatched paths without the path itself', async () => {
    const lines: string[] = [];
    restore = captureLogs((_level, line) => lines.push(line));
    const { app } = makeApp();
    await request(app).get('/api/v1/public/secret-looking-path');
    expect(lines.join('\n')).toContain('route=unmatched');
    expect(lines.join('\n')).not.toContain('secret-looking-path');
  });
});
