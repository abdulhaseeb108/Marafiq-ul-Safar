import { describe, expect, it } from 'vitest';
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
  });

  it('refuses short or identical secrets and a malformed TOTP key', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'short' })).toThrow();
    expect(() => loadEnv({ ...valid, JWT_REFRESH_SECRET: valid.JWT_SECRET })).toThrow();
    expect(() => loadEnv({ ...valid, TOTP_ENC_KEY: 'zz' })).toThrow();
    expect(() => loadEnv({ ...valid, MONGODB_URI: '' })).toThrow();
  });
});
