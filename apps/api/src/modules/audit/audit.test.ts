import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CookieJar,
  TEST_PASSWORD,
  makeApp,
  seedUser,
  signInAs,
  totpCode,
  type SeededUser,
} from '../../test/helpers.js';
import { AuditEventModel } from './audit.model.js';
import { recordAudit, sanitizeAuditData } from './audit.service.js';

const USERS = '/api/v1/admin/users';
const AUDIT = '/api/v1/admin/audit';

async function events(action: string) {
  return AuditEventModel.find({ action }).lean();
}

describe('audit events', () => {
  let app: Express;
  let admin: SeededUser;
  let adminJar: CookieJar;

  beforeEach(async () => {
    app = makeApp().app;
    admin = await seedUser({ role: 'admin' });
    adminJar = await signInAs(app, admin);
  });

  it('records user create with actor, role, entity, after, ip and time', async () => {
    const res = await request(app)
      .post(USERS)
      .set('Cookie', adminJar.header())
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ email: 'new@example.com', name: 'New Person', role: 'ops', password: TEST_PASSWORD });
    expect(res.status).toBe(201);

    const [event] = await events('user.create');
    expect(event).toBeDefined();
    expect(String(event?.actorId)).toBe(admin.id);
    expect(event?.actorRole).toBe('admin');
    expect(event?.entityType).toBe('user');
    expect(String(event?.entityId)).toBe(res.body.id);
    expect(event?.before).toBeUndefined();
    expect(event?.after).toMatchObject({ email: 'new@example.com', role: 'ops', active: true });
    expect(event?.ip).toBe('203.0.113.9');
    expect(event?.at).toBeInstanceOf(Date);
  });

  it('records user update with before and after', async () => {
    const target = await seedUser({ role: 'sales', name: 'Old Name' });
    await request(app)
      .patch(`${USERS}/${target.id}`)
      .set('Cookie', adminJar.header())
      .send({ name: 'New Name', role: 'finance' });

    const [event] = await events('user.update');
    expect(event?.before).toMatchObject({ name: 'Old Name', role: 'sales' });
    expect(event?.after).toMatchObject({ name: 'New Name', role: 'finance' });
  });

  it('records a password change without the password or its hash', async () => {
    const target = await seedUser({ role: 'sales' });
    await request(app)
      .patch(`${USERS}/${target.id}`)
      .set('Cookie', adminJar.header())
      .send({ password: 'a-brand-new-password-9' });

    const [event] = await events('user.update');
    expect(event?.after).toMatchObject({ credentialChanged: true });
    expect(JSON.stringify(event)).not.toContain('a-brand-new-password-9');
  });

  it('records deactivate and reactivate', async () => {
    const target = await seedUser({ role: 'sales' });
    await request(app).post(`${USERS}/${target.id}/deactivate`).set('Cookie', adminJar.header());
    await request(app)
      .patch(`${USERS}/${target.id}`)
      .set('Cookie', adminJar.header())
      .send({ active: true });

    expect((await events('user.deactivate'))[0]?.after).toMatchObject({ active: false });
    expect((await events('user.reactivate'))[0]?.after).toMatchObject({ active: true });
  });

  it('records login success and login failure', async () => {
    const seeded = await seedUser({ role: 'ops' });
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: seeded.email, password: 'wrong-pass-123' });
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'x' });
    await signInAs(app, seeded);

    const failures = await events('auth.login_failure');
    expect(failures).toHaveLength(2);
    const known = failures.find((e) => e.entityId);
    const unknown = failures.find((e) => !e.entityId);
    expect(String(known?.entityId)).toBe(seeded.id);
    expect(known?.actorRole).toBe('public');
    expect(unknown).toBeDefined();
    // The typed email is not stored: people paste passwords into that box.
    expect(JSON.stringify(unknown)).not.toContain('ghost@example.com');

    const successes = await events('auth.login_success');
    expect(successes.map((e) => String(e.actorId))).toContain(seeded.id);
  });

  it('records 2FA enrollment, enabling and reset', async () => {
    const fresh = await seedUser({ role: 'admin', totp: false });
    const jar = new CookieJar();
    jar.absorb(
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: fresh.email, password: TEST_PASSWORD }),
    );
    const enroll = await request(app).post('/api/v1/auth/2fa/enroll').set('Cookie', jar.header());
    const secret = enroll.body.secret as string;
    await request(app)
      .post('/api/v1/auth/2fa')
      .set('Cookie', jar.header())
      .send({ code: await totpCode(secret) });
    await request(app).post(`${USERS}/${fresh.id}/reset-2fa`).set('Cookie', adminJar.header());

    expect(await events('auth.2fa_enroll_started')).toHaveLength(1);
    const [enabled] = await events('auth.2fa_enabled');
    expect(String(enabled?.entityId)).toBe(fresh.id);
    const [reset] = await events('auth.2fa_reset');
    expect(String(reset?.actorId)).toBe(admin.id);
    expect(String(reset?.entityId)).toBe(fresh.id);

    const everything = JSON.stringify(await AuditEventModel.find().lean());
    expect(everything).not.toContain(secret);
  });

  it('never stores passwords, hashes, tokens or secrets', async () => {
    const target = await seedUser({ role: 'sales' });
    await request(app)
      .post(USERS)
      .set('Cookie', adminJar.header())
      .send({ email: 'x@example.com', name: 'X', role: 'ops', password: TEST_PASSWORD });
    await request(app)
      .patch(`${USERS}/${target.id}`)
      .set('Cookie', adminJar.header())
      .send({ role: 'ops' });
    await request(app).post('/api/v1/auth/refresh').set('Cookie', adminJar.header());
    await request(app).post('/api/v1/auth/logout').set('Cookie', adminJar.header());

    const all = await AuditEventModel.find().lean();
    expect(all.length).toBeGreaterThan(3);
    const dump = JSON.stringify(all);
    expect(dump).not.toContain(TEST_PASSWORD);
    expect(dump).not.toContain('$argon2');
    expect(dump).not.toContain(admin.totpSecret);
    expect(dump).not.toContain(adminJar.get('msf_access'));
    expect(dump).not.toContain(adminJar.get('msf_refresh'));
    expect(dump).not.toMatch(/"(password|passwordHash|totpSecretEnc|tokenHash|secret|token)"/i);
  });
});

describe('sanitizeAuditData', () => {
  it('drops secret-looking keys at any depth', () => {
    const clean = sanitizeAuditData({
      name: 'A',
      password: 'p',
      passwordHash: 'h',
      totpSecretEnc: 's',
      nested: { refreshToken: 't', keep: 1, list: [{ apiSecret: 'z', ok: true }] },
    });
    expect(clean).toEqual({ name: 'A', nested: { keep: 1, list: [{ ok: true }] } });
  });

  it('is applied by recordAudit as a last line of defence', async () => {
    await recordAudit({
      actor: { role: 'system' },
      action: 'test.event',
      entityType: 'user',
      after: { name: 'A', passwordHash: 'should-not-be-stored' },
    });
    const [event] = await AuditEventModel.find({ action: 'test.event' }).lean();
    expect(event?.after).toEqual({ name: 'A' });
  });
});

describe('GET /admin/audit', () => {
  it('filters by action, entity and actor, newest first, with paging', async () => {
    const { app } = makeApp();
    const admin = await seedUser({ role: 'admin' });
    const jar = await signInAs(app, admin);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(USERS)
        .set('Cookie', jar.header())
        .send({ email: `u${i}@example.com`, name: `U${i}`, role: 'ops', password: TEST_PASSWORD });
      ids.push(res.body.id as string);
    }

    const creates = await request(app)
      .get(`${AUDIT}?action=user.create`)
      .set('Cookie', jar.header());
    expect(creates.status).toBe(200);
    expect(creates.body.total).toBe(3);
    expect(creates.body.items[0].entityId).toBe(ids[2]); // newest first

    const paged = await request(app)
      .get(`${AUDIT}?action=user.create&limit=2&page=2`)
      .set('Cookie', jar.header());
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body).toMatchObject({ page: 2, limit: 2, total: 3 });

    const byEntity = await request(app)
      .get(`${AUDIT}?entityType=user&entityId=${ids[0]}`)
      .set('Cookie', jar.header());
    expect(byEntity.body.total).toBe(1);

    const byActor = await request(app)
      .get(`${AUDIT}?actorId=${admin.id}`)
      .set('Cookie', jar.header());
    expect(byActor.body.total).toBeGreaterThanOrEqual(4); // login + 3 creates

    const future = await request(app)
      .get(`${AUDIT}?from=2999-01-01T00:00:00.000Z`)
      .set('Cookie', jar.header());
    expect(future.body.total).toBe(0);
  });

  it('rejects bad filters', async () => {
    const { app } = makeApp();
    const jar = await signInAs(app, await seedUser({ role: 'admin' }));
    const res = await request(app)
      .get(`${AUDIT}?entityId=nope&limit=1000`)
      .set('Cookie', jar.header());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});
