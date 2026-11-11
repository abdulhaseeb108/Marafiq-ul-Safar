import { SettingsViewSchema } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, makeApp, seedUser, signInAs } from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { SettingsModel } from './settings.model.js';

const URL = '/api/v1/admin/settings';

describe('settings', () => {
  let app: Express;
  let jar: CookieJar;

  beforeEach(async () => {
    app = makeApp().app;
    jar = await signInAs(app, await seedUser({ role: 'admin' }));
  });

  it('returns the defaults from docs/02 and docs/05 on first read', async () => {
    const res = await request(app).get(URL).set('Cookie', jar.header());
    expect(res.status).toBe(200);
    const settings = SettingsViewSchema.parse(res.body);
    expect(settings).toMatchObject({
      markupPercent: 0,
      estimateExpiryHours: 72,
      responseTimeText: 'within 1 business day',
      infantHotelCharge: 'none',
      childAsAdult: true,
      showSupplierRates: true,
    });
  });

  it('keeps exactly one settings document however often it is read or written', async () => {
    await request(app).get(URL).set('Cookie', jar.header());
    await request(app).get(URL).set('Cookie', jar.header());
    await request(app).put(URL).set('Cookie', jar.header()).send({ markupPercent: 2.5 });
    await request(app).put(URL).set('Cookie', jar.header()).send({ childAsAdult: false });
    expect(await SettingsModel.countDocuments()).toBe(1);
  });

  it('updates only the fields sent', async () => {
    await request(app).put(URL).set('Cookie', jar.header()).send({ markupPercent: 5 });
    const res = await request(app)
      .put(URL)
      .set('Cookie', jar.header())
      .send({ responseTimeText: 'within 2 business days' });
    expect(res.body).toMatchObject({
      markupPercent: 5,
      responseTimeText: 'within 2 business days',
    });
  });

  it('rejects out-of-range and unknown values', async () => {
    const send = (body: object) => request(app).put(URL).set('Cookie', jar.header()).send(body);
    expect((await send({ markupPercent: -1 })).status).toBe(400);
    expect((await send({ markupPercent: 101 })).status).toBe(400);
    expect((await send({ estimateExpiryHours: 0 })).status).toBe(400);
    expect((await send({ infantHotelCharge: 'half' })).status).toBe(400);
    expect((await send({ responseTimeText: '' })).status).toBe(400);
    expect((await send({})).status).toBe(400);
  });

  it('audits the change with before and after', async () => {
    await request(app).put(URL).set('Cookie', jar.header()).send({ markupPercent: 3 });
    const [event] = await AuditEventModel.find({ action: 'settings.update' }).lean();
    expect(event?.before).toMatchObject({ markupPercent: 0 });
    expect(event?.after).toMatchObject({ markupPercent: 3 });
    expect(event?.entityType).toBe('settings');
  });
});
