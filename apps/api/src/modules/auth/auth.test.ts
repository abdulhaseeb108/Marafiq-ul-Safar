import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  CookieJar,
  TEST_PASSWORD,
  makeApp,
  seedUser,
  setCookieLine,
  signInAs,
  testConfig,
  totpCode,
} from '../../test/helpers.js';
import { UserModel } from '../users/user.model.js';
import { SessionModel } from './session.model.js';

const LOGIN = '/api/v1/auth/login';
const TWO_FA = '/api/v1/auth/2fa';
const ENROLL = '/api/v1/auth/2fa/enroll';
const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';
const ME = '/api/v1/auth/me';
const ADMIN_USERS = '/api/v1/admin/users';

describe('login', () => {
  it('signs in a non-admin and sets httpOnly, secure, sameSite cookies', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    const res = await request(app)
      .post(LOGIN)
      .send({ email: seeded.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.next).toBe('done');
    expect(res.body.user).toMatchObject({ email: seeded.email, role: 'sales' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2|totp/i);

    for (const name of ['msf_access', 'msf_refresh']) {
      const line = setCookieLine(res, name);
      expect(line, name).toMatch(/HttpOnly/i);
      expect(line, name).toMatch(/Secure/i);
      expect(line, name).toMatch(/SameSite=Strict/i);
    }
  });

  it('accepts the email in any letter case', async () => {
    const { app } = makeApp();
    await seedUser({ role: 'ops', email: 'ops.person@example.com' });
    const res = await request(app)
      .post(LOGIN)
      .send({ email: '  Ops.Person@Example.com ', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });

  it('returns the same error for a wrong email and a wrong password', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    const wrongPassword = await request(app)
      .post(LOGIN)
      .send({ email: seeded.email, password: 'wrong-password-123' });
    const wrongEmail = await request(app)
      .post(LOGIN)
      .send({ email: 'nobody@example.com', password: TEST_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(wrongEmail.body).toEqual(wrongPassword.body);
    expect(wrongPassword.body.error.code).toBe('invalid_credentials');
    expect(setCookieLine(wrongPassword, 'msf_access')).toBeUndefined();
  });

  it('refuses a deactivated user with the same error', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales', active: false });
    const res = await request(app)
      .post(LOGIN)
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('rejects a malformed body with field errors', async () => {
    const { app } = makeApp();
    const res = await request(app).post(LOGIN).send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.fields).toHaveProperty('email');
  });
});

describe('login rate limit (5 failures per 15 minutes)', () => {
  it('blocks an email after 5 failures, even with the right password and a new IP', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(LOGIN)
        .set('X-Forwarded-For', `10.0.0.${i + 1}`) // a different IP each time
        .send({ email: seeded.email, password: 'wrong-password-123' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post(LOGIN)
      .set('X-Forwarded-For', '10.0.0.99')
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('blocks an IP after 5 failures across different emails', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post(LOGIN)
        .set('X-Forwarded-For', '10.1.1.1')
        .send({ email: `guess${i}@example.com`, password: 'wrong-password-123' });
    }
    const blocked = await request(app)
      .post(LOGIN)
      .set('X-Forwarded-For', '10.1.1.1')
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(blocked.status).toBe(429);

    const otherIp = await request(app)
      .post(LOGIN)
      .set('X-Forwarded-For', '10.1.1.2')
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(otherIp.status).toBe(200);
  });

  it('does not lock out after fewer than 5 failures', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    for (let i = 0; i < 4; i++) {
      await request(app).post(LOGIN).send({ email: seeded.email, password: 'wrong-password-123' });
    }
    const res = await request(app)
      .post(LOGIN)
      .send({ email: seeded.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('two-factor authentication', () => {
  it('admin without 2FA gets no session and cannot reach admin routes until enrolled', async () => {
    const { app, config } = makeApp();
    const seeded = await seedUser({ role: 'admin', totp: false });
    const jar = new CookieJar();

    const login = await request(app)
      .post(LOGIN)
      .send({ email: seeded.email, password: TEST_PASSWORD });
    jar.absorb(login);
    expect(login.status).toBe(200);
    expect(login.body.next).toBe('enroll_2fa');
    expect(login.body.user).toBeUndefined();
    expect(jar.get('msf_access')).toBeUndefined();
    expect(jar.get('msf_refresh')).toBeUndefined();

    const early = await request(app).get(ADMIN_USERS).set('Cookie', jar.header());
    expect(early.status).toBe(401);

    const enroll = await request(app).post(ENROLL).set('Cookie', jar.header());
    expect(enroll.status).toBe(200);
    expect(enroll.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret = enroll.body.secret as string;

    // Stored encrypted, never in plain text, and not active until proven.
    const stored = await UserModel.findById(seeded.id).lean();
    expect(stored?.totpSecretEnc).toBeUndefined();
    expect(stored?.totpPendingSecretEnc).toBeDefined();
    expect(stored?.totpPendingSecretEnc).not.toContain(secret);

    const wrong = await request(app)
      .post(TWO_FA)
      .set('Cookie', jar.header())
      .send({ code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_code');

    const ok = await request(app)
      .post(TWO_FA)
      .set('Cookie', jar.header())
      .send({ code: await totpCode(secret) });
    jar.absorb(ok);
    expect(ok.status).toBe(200);
    expect(ok.body.user.twoFactorEnabled).toBe(true);
    expect(jar.get('msf_mfa')).toBeUndefined(); // pending cookie cleared

    const after = await request(app).get(ADMIN_USERS).set('Cookie', jar.header());
    expect(after.status).toBe(200);

    const enrolled = await UserModel.findById(seeded.id).lean();
    expect(enrolled?.totpSecretEnc).toBeDefined();
    expect(enrolled?.totpSecretEnc).not.toContain(secret);
    expect(enrolled?.totpPendingSecretEnc).toBeUndefined();
    expect(config.totpKey).toHaveLength(32);
  });

  it('enrolled admin must pass the code step on every login', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'admin' });
    const jar = new CookieJar();

    const login = await request(app)
      .post(LOGIN)
      .send({ email: seeded.email, password: TEST_PASSWORD });
    jar.absorb(login);
    expect(login.body.next).toBe('2fa');
    expect(jar.get('msf_access')).toBeUndefined();

    const ok = await request(app)
      .post(TWO_FA)
      .set('Cookie', jar.header())
      .send({ code: await totpCode(seeded.totpSecret as string) });
    jar.absorb(ok);
    expect(ok.status).toBe(200);
    expect((await request(app).get(ADMIN_USERS).set('Cookie', jar.header())).status).toBe(200);
  });

  it('rejects an admin access token that was not issued after 2FA', async () => {
    const { app, config } = makeApp();
    const seeded = await seedUser({ role: 'admin' });
    const session = await SessionModel.create({
      userId: seeded.id,
      familyId: 'forged-family',
      tokenHash: 'x'.repeat(64),
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const token = jwt.sign(
      { sub: seeded.id, role: 'admin', mfa: false, sid: session.familyId, typ: 'access' },
      config.jwtSecret,
      { expiresIn: 60 },
    );
    const res = await request(app).get(ADMIN_USERS).set('Cookie', `msf_access=${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('2fa_required');
  });

  it('a user promoted to admin cannot use admin routes on a session without 2FA', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    const jar = await signInAs(app, seeded);
    await UserModel.updateOne({ _id: seeded.id }, { role: 'admin' });
    const res = await request(app).get(ADMIN_USERS).set('Cookie', jar.header());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('2fa_required');
  });

  it('locks the code step after 5 wrong codes', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'admin' });
    const jar = new CookieJar();
    jar.absorb(
      await request(app).post(LOGIN).send({ email: seeded.email, password: TEST_PASSWORD }),
    );
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(TWO_FA)
        .set('Cookie', jar.header())
        .send({ code: '000000' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post(TWO_FA)
      .set('Cookie', jar.header())
      .send({ code: await totpCode(seeded.totpSecret as string) });
    expect(blocked.status).toBe(429);
  });

  it('does not accept the 2FA step without a pending login', async () => {
    const { app } = makeApp();
    const res = await request(app).post(TWO_FA).send({ code: '123456' });
    expect(res.status).toBe(401);
  });
});

describe('refresh and logout', () => {
  it('rotates the refresh token and rejects the old one', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'ops' });
    const jar = await signInAs(app, seeded);
    const firstRefresh = jar.get('msf_refresh') as string;

    const rotated = await request(app).post(REFRESH).set('Cookie', jar.header());
    expect(rotated.status).toBe(200);
    jar.absorb(rotated);
    const secondRefresh = jar.get('msf_refresh') as string;
    expect(secondRefresh).not.toBe(firstRefresh);
    expect((await request(app).get(ME).set('Cookie', jar.header())).status).toBe(200);

    // Replaying the old token is treated as theft: the whole session family dies.
    const replay = await request(app).post(REFRESH).set('Cookie', `msf_refresh=${firstRefresh}`);
    expect(replay.status).toBe(401);
    const afterReplay = await request(app).post(REFRESH).set('Cookie', jar.header());
    expect(afterReplay.status).toBe(401);
    expect((await request(app).get(ME).set('Cookie', jar.header())).status).toBe(401);
  });

  it('stores only a hash of the refresh token', async () => {
    const { app } = makeApp();
    const jar = await signInAs(app, await seedUser({ role: 'ops' }));
    const sessions = await SessionModel.find().lean();
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(jar.get('msf_refresh'));
  });

  it('rejects refresh without a cookie or with an unknown token', async () => {
    const { app } = makeApp();
    expect((await request(app).post(REFRESH)).status).toBe(401);
    const res = await request(app).post(REFRESH).set('Cookie', 'msf_refresh=unknown');
    expect(res.status).toBe(401);
  });

  it('logout invalidates the access and refresh tokens and clears cookies', async () => {
    const { app } = makeApp();
    const jar = await signInAs(app, await seedUser({ role: 'finance' }));
    const before = jar.header();

    const out = await request(app).post(LOGOUT).set('Cookie', before);
    expect(out.status).toBe(204);
    expect(setCookieLine(out, 'msf_access')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(setCookieLine(out, 'msf_refresh')).toMatch(/Expires=Thu, 01 Jan 1970/);

    // The old cookies no longer work, even though the JWT has not expired.
    expect((await request(app).get(ME).set('Cookie', before)).status).toBe(401);
    expect((await request(app).post(REFRESH).set('Cookie', before)).status).toBe(401);
  });

  it('deactivating a user ends their live session at once', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    const jar = await signInAs(app, seeded);
    const adminJar = await signInAs(app, await seedUser({ role: 'admin' }));

    const res = await request(app)
      .post(`${ADMIN_USERS}/${seeded.id}/deactivate`)
      .set('Cookie', adminJar.header());
    expect(res.status).toBe(200);

    expect((await request(app).get(ME).set('Cookie', jar.header())).status).toBe(401);
    expect((await request(app).post(REFRESH).set('Cookie', jar.header())).status).toBe(401);
  });

  it('rejects an access token signed with another secret', async () => {
    const { app } = makeApp();
    const seeded = await seedUser({ role: 'sales' });
    const token = jwt.sign({ sub: seeded.id, role: 'sales', typ: 'access' }, 'another-secret');
    const res = await request(app).get(ME).set('Cookie', `msf_access=${token}`);
    expect(res.status).toBe(401);
    expect(testConfig().jwtSecret).not.toBe('another-secret');
  });
});
