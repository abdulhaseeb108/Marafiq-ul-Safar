/**
 * Sign-in lock-outs live in MongoDB (login-limiter.ts), so restarting or
 * redeploying the API does not hand an attacker a fresh set of guesses.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeApp, seedUser, TEST_PASSWORD } from '../../test/helpers.js';
import { LoginAttemptModel, MongoLoginLimiter } from './login-limiter.js';

const LOGIN = '/api/v1/auth/login';

describe('MongoLoginLimiter', () => {
  it('locks a key at the limit, says when to retry, and opens again after the window', async () => {
    let now = Date.parse('2026-11-18T12:00:00Z');
    const limiter = new MongoLoginLimiter({ maxFailures: 3, windowMs: 60_000 }, () => now);
    for (let i = 0; i < 2; i++) await limiter.recordFailure('email:a@example.com');
    expect(await limiter.retryAfterSeconds('email:a@example.com')).toBe(0);
    await limiter.recordFailure('email:a@example.com');
    expect(await limiter.retryAfterSeconds('email:a@example.com')).toBe(60);
    expect(await limiter.retryAfterSeconds('email:b@example.com')).toBe(0);

    now += 61_000; // window over: the next failure starts a new count
    expect(await limiter.retryAfterSeconds('email:a@example.com')).toBe(0);
    await limiter.recordFailure('email:a@example.com');
    expect((await LoginAttemptModel.findOne().lean())?.count).toBe(1);
  });

  it('reset clears a key', async () => {
    const limiter = new MongoLoginLimiter({ maxFailures: 1, windowMs: 60_000 });
    await limiter.recordFailure('ip:203.0.113.9');
    expect(await limiter.retryAfterSeconds('ip:203.0.113.9')).toBeGreaterThan(0);
    await limiter.reset('ip:203.0.113.9');
    expect(await limiter.retryAfterSeconds('ip:203.0.113.9')).toBe(0);
  });

  it('counts failures sent at the same moment exactly (one atomic write each)', async () => {
    const limiter = new MongoLoginLimiter({ maxFailures: 100, windowMs: 60_000 });
    await Promise.all(Array.from({ length: 20 }, () => limiter.recordFailure('ip:198.51.100.1')));
    expect((await LoginAttemptModel.findOne().lean())?.count).toBe(20);
  });

  it('stores no email address or IP, only hashed keys', async () => {
    const limiter = new MongoLoginLimiter({ maxFailures: 5, windowMs: 60_000 });
    await limiter.recordFailure('email:secret.person@example.com');
    await limiter.recordFailure('ip:203.0.113.77');
    const rows = await LoginAttemptModel.find().lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row._id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toMatch(/secret\.person|example\.com|203\.0\.113/);
  });
});

describe('sign-in lock-out across an API restart', () => {
  it('is still locked when a new API process starts', async () => {
    const seeded = await seedUser({ role: 'sales' });
    const before = makeApp().app;
    for (let i = 0; i < 5; i++) {
      const res = await request(before)
        .post(LOGIN)
        .set('X-Forwarded-For', '10.9.0.1')
        .send({ email: seeded.email, password: 'wrong-password-123' });
      expect(res.status).toBe(401);
    }

    // A fresh app: nothing in memory carries over, only the database.
    const after = makeApp().app;
    const blocked = await request(after)
      .post(LOGIN)
      .set('X-Forwarded-For', '10.9.0.2')
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });

  it('a successful sign-in clears the email lock-out counter', async () => {
    const seeded = await seedUser({ role: 'sales' });
    const { app } = makeApp();
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(LOGIN)
        .set('X-Forwarded-For', '10.9.1.1')
        .send({ email: seeded.email, password: 'wrong-password-123' });
    }
    const ok = await request(app)
      .post(LOGIN)
      .set('X-Forwarded-For', '10.9.1.2')
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(ok.status).toBe(200);
    // Three more failures would have locked a counter that was not cleared.
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(LOGIN)
        .set('X-Forwarded-For', '10.9.1.3')
        .send({ email: seeded.email, password: 'wrong-password-123' });
    }
    const still = await request(app)
      .post(LOGIN)
      .set('X-Forwarded-For', '10.9.1.4')
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(still.status).toBe(200);
  });
});
