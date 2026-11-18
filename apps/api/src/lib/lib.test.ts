import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../config/app-config.js';
import { loadEnv } from '../config/env.js';
import { decryptSecret, encryptSecret, hashToken, randomToken } from './crypto.js';
import { FailureLimiter } from './rate-limiter.js';

describe('secret encryption (AES-256-GCM)', () => {
  const key = Buffer.alloc(32, 1);

  it('round-trips and never contains the plain text', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('fails on the wrong key or tampered data', () => {
    const enc = encryptSecret('secret', key);
    expect(() => decryptSecret(enc, Buffer.alloc(32, 2))).toThrow();
    const [iv, tag, data] = enc.split('.') as [string, string, string];
    const flipped = Buffer.from(data, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join('.'), key)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => encryptSecret('x', Buffer.alloc(16))).toThrow();
  });
});

describe('tokens', () => {
  it('generates 32+ random bytes and hashes with a key', () => {
    const a = randomToken();
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(randomToken());
    expect(hashToken(a, 'k1')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a, 'k1')).toBe(hashToken(a, 'k1'));
    expect(hashToken(a, 'k1')).not.toBe(hashToken(a, 'k2'));
  });
});

describe('FailureLimiter', () => {
  it('blocks at the limit and frees the key when the window passes', () => {
    let now = 0;
    const limiter = new FailureLimiter({ maxFailures: 5, windowMs: 1000 }, () => now);
    for (let i = 0; i < 4; i++) limiter.recordFailure('k');
    expect(limiter.retryAfterSeconds('k')).toBe(0);
    limiter.recordFailure('k');
    expect(limiter.retryAfterSeconds('k')).toBe(1);
    expect(limiter.retryAfterSeconds('other')).toBe(0);
    now = 1001;
    expect(limiter.retryAfterSeconds('k')).toBe(0);
  });

  it('take() counts allowed attempts and refuses, without counting, at the limit', () => {
    let now = 0;
    const limiter = new FailureLimiter({ maxFailures: 2, windowMs: 1000 }, () => now);
    expect(limiter.take('k')).toBe(0);
    expect(limiter.take('k')).toBe(0);
    expect(limiter.take('k')).toBe(1);
    now = 1001;
    expect(limiter.take('k')).toBe(0);
  });

  it('reset clears a key', () => {
    const limiter = new FailureLimiter({ maxFailures: 1, windowMs: 1000 });
    limiter.recordFailure('k');
    expect(limiter.retryAfterSeconds('k')).toBeGreaterThan(0);
    limiter.reset('k');
    expect(limiter.retryAfterSeconds('k')).toBe(0);
  });
});

describe('loadEnv', () => {
  const valid = {
    MONGODB_URI: 'mongodb://localhost/db',
    JWT_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    TOTP_ENC_KEY: 'c'.repeat(64),
  };

  it('accepts a valid environment and treats blank values as unset', () => {
    const env = loadEnv({ ...valid, COOKIE_DOMAIN: '', SEED_ADMIN_EMAIL: '' });
    expect(env.PORT).toBe(4000);
    expect(env.COOKIE_DOMAIN).toBeUndefined();
    expect(configFromEnv(env).documentParserLimits.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(configFromEnv(env).maxConcurrentDocumentUploads).toBe(2);
  });

  it('accepts bounded document resource-limit overrides', () => {
    const env = loadEnv({
      ...valid,
      DOCUMENT_MAX_FILE_BYTES: '1048576',
      DOCUMENT_MAX_PDF_PAGES: '12',
      DOCUMENT_MAX_CONCURRENT_UPLOADS: '3',
    });
    const config = configFromEnv(env);
    expect(config.documentParserLimits).toMatchObject({
      maxFileBytes: 1_048_576,
      maxPdfPages: 12,
    });
    expect(config.maxConcurrentDocumentUploads).toBe(3);
    expect(() => loadEnv({ ...valid, DOCUMENT_EVIDENCE_CHUNK_BYTES: '70000' })).toThrow();
  });

  it('refuses short or identical secrets and a malformed TOTP key', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'short' })).toThrow();
    expect(() => loadEnv({ ...valid, JWT_REFRESH_SECRET: valid.JWT_SECRET })).toThrow();
    expect(() => loadEnv({ ...valid, TOTP_ENC_KEY: 'zz' })).toThrow();
    expect(() => loadEnv({ ...valid, MONGODB_URI: '' })).toThrow();
  });

  it('needs MAIL_FROM whenever a Resend key is set', () => {
    expect(() => loadEnv({ ...valid, RESEND_API_KEY: 're_test' })).toThrow(/MAIL_FROM/);
    expect(loadEnv({ ...valid, RESEND_API_KEY: 're_test', MAIL_FROM: 'a@b.test' }).MAIL_FROM).toBe(
      'a@b.test',
    );
  });

  it('uses the dev site for quote links outside production, without a trailing slash', () => {
    expect(configFromEnv(loadEnv(valid)).publicSiteUrl).toBe('http://localhost:5175');
    const env = loadEnv({ ...valid, PUBLIC_SITE_URL: 'http://localhost:4179/' });
    expect(configFromEnv(env).publicSiteUrl).toBe('http://localhost:4179');
  });

  it('requires a real https PUBLIC_SITE_URL in production', () => {
    const production = { ...valid, NODE_ENV: 'production' };
    const problem = (value?: string) => {
      try {
        loadEnv({ ...production, PUBLIC_SITE_URL: value });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(problem(undefined)).toMatch(/PUBLIC_SITE_URL: is required in production/);
    expect(problem('')).toMatch(/PUBLIC_SITE_URL: is required in production/);
    expect(problem('not a url')).toMatch(/PUBLIC_SITE_URL: must be a valid URL/);
    expect(problem('http://example.com')).toMatch(/PUBLIC_SITE_URL: must use https/);
    expect(problem('ftp://example.com')).toMatch(/PUBLIC_SITE_URL: must be an http\(s\) URL/);
    expect(problem('https://localhost')).toMatch(/PUBLIC_SITE_URL: must not be a local address/);
    expect(problem('https://127.0.0.1:8443')).toMatch(/must not be a local address/);
    expect(problem('https://user:pw@example.com')).toMatch(/must not contain credentials/);
    expect(problem('https://example.com/?a=1')).toMatch(/must not contain credentials/);
    expect(problem('https://example.com')).toBeNull();
    const env = loadEnv({ ...production, PUBLIC_SITE_URL: 'https://example.com/' });
    expect(configFromEnv(env).publicSiteUrl).toBe('https://example.com');
  });

  it('rejects a malformed PUBLIC_SITE_URL in development too', () => {
    expect(() => loadEnv({ ...valid, PUBLIC_SITE_URL: 'example.com' })).toThrow(/PUBLIC_SITE_URL/);
  });

  it('validates WEB_ORIGIN as bare origins, https in production', () => {
    expect(configFromEnv(loadEnv(valid)).webOrigins).toEqual([]);
    const two = loadEnv({ ...valid, WEB_ORIGIN: 'http://localhost:5175, https://example.com' });
    expect(configFromEnv(two).webOrigins).toEqual(['http://localhost:5175', 'https://example.com']);
    expect(() => loadEnv({ ...valid, WEB_ORIGIN: 'https://example.com/' })).toThrow(
      /WEB_ORIGIN: "https:\/\/example.com\/" must be an origin only/,
    );
    expect(() => loadEnv({ ...valid, WEB_ORIGIN: 'nope' })).toThrow(/WEB_ORIGIN/);
    const production = { ...valid, NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://example.com' };
    expect(() => loadEnv({ ...production, WEB_ORIGIN: 'http://example.com' })).toThrow(
      /WEB_ORIGIN: must use https in production/,
    );
  });

  it('refuses the origin lock together with a CORS allow-list', () => {
    const secret = 'x'.repeat(40);
    expect(() =>
      loadEnv({ ...valid, ORIGIN_PROXY_SECRET: secret, WEB_ORIGIN: 'http://localhost:5175' }),
    ).toThrow(/ORIGIN_PROXY_SECRET: cannot be used with WEB_ORIGIN/);
    // Either one alone is fine.
    expect(() => loadEnv({ ...valid, ORIGIN_PROXY_SECRET: secret })).not.toThrow();
    expect(() => loadEnv({ ...valid, WEB_ORIGIN: 'http://localhost:5175' })).not.toThrow();
  });

  it('refuses to start in production without the services customers depend on', () => {
    const production = { ...valid, NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://example.com' };
    expect(() => loadEnv({ ...production, PUBLIC_SITE_URL: '' })).toThrow(
      /PUBLIC_SITE_URL: is required in production/,
    );
    expect(() => loadEnv({ ...production, PUBLIC_SITE_URL: 'http://example.com' })).toThrow(
      /PUBLIC_SITE_URL: must use https in production/,
    );
    expect(() => loadEnv({ ...production, PUBLIC_SITE_URL: 'https://localhost' })).toThrow(
      /PUBLIC_SITE_URL: must not be a local address in production/,
    );
    expect(() => loadEnv({ ...production, SENTRY_DSN: 'not a url' })).toThrow(/SENTRY_DSN/);
  });

  it('never prints a rejected value in the startup error', () => {
    const leaked = 'super-secret-value-that-is-too-short';
    try {
      loadEnv({ ...valid, ORIGIN_PROXY_SECRET: 'tiny', JWT_SECRET: leaked.slice(0, 10) });
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/JWT_SECRET/);
      expect(message).not.toContain(leaked.slice(0, 10));
      expect(message).not.toContain('tiny');
    }
  });

  it('sets proxy trust, rate limits and the origin lock from the environment', () => {
    const dev = configFromEnv(loadEnv(valid));
    expect(dev.trustProxy).toBe(false);
    expect(dev.publicRateLimits?.general).toEqual({ max: 60, windowMs: 60_000 });
    expect(dev.publicRateLimits?.inquiries).toEqual({ max: 5, windowMs: 3_600_000 });
    expect(dev.originProxySecret).toBeUndefined();

    const production = { ...valid, NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://example.com' };
    expect(configFromEnv(loadEnv(production)).trustProxy).toBe(1);
    expect(configFromEnv(loadEnv({ ...production, TRUST_PROXY_HOPS: '2' })).trustProxy).toBe(2);
    expect(() => loadEnv({ ...production, TRUST_PROXY_HOPS: '9' })).toThrow(/TRUST_PROXY_HOPS/);

    expect(() => loadEnv({ ...valid, ORIGIN_PROXY_SECRET: 'short' })).toThrow(
      /ORIGIN_PROXY_SECRET/,
    );
    const locked = loadEnv({ ...valid, ORIGIN_PROXY_SECRET: 'x'.repeat(40) });
    expect(configFromEnv(locked).originProxySecret).toBe('x'.repeat(40));
  });

  it('accepts an optional SENTRY_DSN URL', () => {
    expect(loadEnv({ ...valid, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined();
    expect(() => loadEnv({ ...valid, SENTRY_DSN: 'not a url' })).toThrow(/SENTRY_DSN/);
    const dsn = 'https://key@o1.ingest.sentry.io/1';
    expect(loadEnv({ ...valid, SENTRY_DSN: dsn }).SENTRY_DSN).toBe(dsn);
  });
});
