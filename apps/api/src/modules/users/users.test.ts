import { PublicUserSchema } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CookieJar,
  TEST_PASSWORD,
  makeApp,
  seedUser,
  signInAs,
  type SeededUser,
} from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { UserModel } from './user.model.js';
import { seedFirstAdmin } from './users.seed.js';

const USERS = '/api/v1/admin/users';

describe('admin user management', () => {
  let app: Express;
  let admin: SeededUser;
  let jar: CookieJar;

  beforeEach(async () => {
    app = makeApp().app;
    admin = await seedUser({ role: 'admin' });
    jar = await signInAs(app, admin);
  });

  it('creates a user with a hashed password and returns no secrets', async () => {
    const res = await request(app)
      .post(USERS)
      .set('Cookie', jar.header())
      .send({ email: 'Sara@Example.com', name: ' Sara ', role: 'sales', password: TEST_PASSWORD });

    expect(res.status).toBe(201);
    const user = PublicUserSchema.parse(res.body);
    expect(user).toMatchObject({ email: 'sara@example.com', name: 'Sara', role: 'sales' });
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(PublicUserSchema.shape).sort());

    const stored = await UserModel.findById(user.id).lean();
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored?.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it('rejects weak passwords, unknown roles and duplicate emails', async () => {
    const weak = await request(app)
      .post(USERS)
      .set('Cookie', jar.header())
      .send({ email: 'a@example.com', name: 'A', role: 'sales', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.fields).toHaveProperty('password');

    const badRole = await request(app)
      .post(USERS)
      .set('Cookie', jar.header())
      .send({ email: 'a@example.com', name: 'A', role: 'owner', password: TEST_PASSWORD });
    expect(badRole.status).toBe(400);

    const duplicate = await request(app).post(USERS).set('Cookie', jar.header()).send({
      email: admin.email.toUpperCase(),
      name: 'A',
      role: 'sales',
      password: TEST_PASSWORD,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('email_taken');
  });

  it('lists users with paging and without secrets', async () => {
    await seedUser({ role: 'ops' });
    await seedUser({ role: 'finance' });
    const res = await request(app).get(`${USERS}?limit=2`).set('Cookie', jar.header());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 2, total: 3 });
    expect(res.body.items).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totpSecret|argon2/);
  });

  it('updates name and role', async () => {
    const target = await seedUser({ role: 'sales' });
    const res = await request(app)
      .patch(`${USERS}/${target.id}`)
      .set('Cookie', jar.header())
      .send({ name: 'Renamed', role: 'ops' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', role: 'ops' });
  });

  it('a password reset by an admin lets the user sign in with the new password only', async () => {
    const target = await seedUser({ role: 'sales' });
    const oldJar = await signInAs(app, target);
    await request(app)
      .patch(`${USERS}/${target.id}`)
      .set('Cookie', jar.header())
      .send({ password: 'a-brand-new-password-9' });

    // Existing sessions end when the password changes.
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', oldJar.header())).status).toBe(
      401,
    );
    const oldPw = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: TEST_PASSWORD });
    expect(oldPw.status).toBe(401);
    const newPw = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: 'a-brand-new-password-9' });
    expect(newPw.status).toBe(200);
  });

  it('deactivates instead of deleting; the record stays', async () => {
    const target = await seedUser({ role: 'sales' });
    const res = await request(app)
      .post(`${USERS}/${target.id}/deactivate`)
      .set('Cookie', jar.header());
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(await UserModel.countDocuments({ _id: target.id })).toBe(1);

    const hardDelete = await request(app)
      .delete(`${USERS}/${target.id}`)
      .set('Cookie', jar.header());
    expect(hardDelete.status).toBe(404);
    expect(await UserModel.countDocuments({ _id: target.id })).toBe(1);
  });

  it('stops an admin from deactivating or demoting themselves', async () => {
    const off = await request(app)
      .post(`${USERS}/${admin.id}/deactivate`)
      .set('Cookie', jar.header());
    expect(off.status).toBe(400);
    expect(off.body.error.code).toBe('cannot_modify_self');
    const demote = await request(app)
      .patch(`${USERS}/${admin.id}`)
      .set('Cookie', jar.header())
      .send({ role: 'sales' });
    expect(demote.status).toBe(400);
  });

  it('resetting 2FA forces an admin to enroll again', async () => {
    const other = await seedUser({ role: 'admin' });
    const res = await request(app)
      .post(`${USERS}/${other.id}/reset-2fa`)
      .set('Cookie', jar.header());
    expect(res.status).toBe(200);
    expect(res.body.twoFactorEnabled).toBe(false);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: other.email, password: TEST_PASSWORD });
    expect(login.body.next).toBe('enroll_2fa');
  });

  it('returns 404 for unknown or malformed ids', async () => {
    const unknown = await request(app)
      .get(`${USERS}/64b7f0c2a1b2c3d4e5f60718`)
      .set('Cookie', jar.header());
    expect(unknown.status).toBe(404);
    const malformed = await request(app).get(`${USERS}/not-an-id`).set('Cookie', jar.header());
    expect(malformed.status).toBe(404);
  });
});

describe('first admin seed', () => {
  const seedEnv = { SEED_ADMIN_EMAIL: 'Owner@Example.com', SEED_ADMIN_PASSWORD: TEST_PASSWORD };

  it('creates one admin when there are no users, and audits it', async () => {
    expect(await seedFirstAdmin(seedEnv)).toBe('created');
    const users = await UserModel.find().lean();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: 'owner@example.com', role: 'admin', active: true });
    expect(users[0]?.passwordHash).toMatch(/^\$argon2id\$/);

    const [event] = await AuditEventModel.find({ action: 'user.seed' }).lean();
    expect(event?.actorRole).toBe('system');
    expect(JSON.stringify(event)).not.toContain(TEST_PASSWORD);
  });

  it('does nothing when any user already exists', async () => {
    await seedUser({ role: 'sales' });
    expect(await seedFirstAdmin(seedEnv)).toBe('skipped_users_exist');
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('does nothing without both variables, and refuses a weak password', async () => {
    expect(await seedFirstAdmin({})).toBe('skipped_not_configured');
    expect(await seedFirstAdmin({ SEED_ADMIN_EMAIL: 'a@example.com' })).toBe(
      'skipped_not_configured',
    );
    await expect(
      seedFirstAdmin({ SEED_ADMIN_EMAIL: 'a@example.com', SEED_ADMIN_PASSWORD: 'short' }),
    ).rejects.toThrow();
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('the seeded admin must enroll 2FA before reaching admin routes', async () => {
    await seedFirstAdmin(seedEnv);
    const { app } = makeApp();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@example.com', password: TEST_PASSWORD });
    expect(login.body.next).toBe('enroll_2fa');
  });
});
