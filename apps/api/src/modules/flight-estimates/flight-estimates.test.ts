import { FlightEstimateViewSchema } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, makeApp, seedUser, signInAs } from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';

const URL = '/api/v1/admin/flight-estimates';

const VALID = {
  originCity: 'Islamabad',
  destination: 'JED',
  lowMinor: 15_000_000, // PKR 150,000
  highMinor: 21_000_000, // PKR 210,000
  validTo: '2027-01-31',
  source: 'partner quote 2026-11-05',
};

describe('flight estimates', () => {
  let app: Express;
  let jar: CookieJar;

  beforeEach(async () => {
    app = makeApp().app;
    jar = await signInAs(app, await seedUser({ role: 'ops' }));
  });

  const post = (body: object) => request(app).post(URL).set('Cookie', jar.header()).send(body);
  const patch = (id: string, body: object) =>
    request(app).patch(`${URL}/${id}`).set('Cookie', jar.header()).send(body);

  it('creates an estimate in PKR minor units', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(201);
    const estimate = FlightEstimateViewSchema.parse(res.body);
    expect(estimate).toMatchObject({ originCity: 'Islamabad', currency: 'PKR', expired: false });
  });

  it('rejects low above high, on create and on update', async () => {
    const bad = await post({ ...VALID, lowMinor: 21_000_001 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields).toHaveProperty('highMinor');

    const good = await post(VALID);
    // Checked against the stored low, not only against fields in this request.
    const update = await patch(good.body.id as string, { highMinor: 1_000_000 });
    expect(update.status).toBe(400);
    expect(update.body.error.fields).toHaveProperty('highMinor');
  });

  it('rejects zero or non-integer money, unknown destinations and bad dates', async () => {
    expect((await post({ ...VALID, lowMinor: 0 })).status).toBe(400);
    expect((await post({ ...VALID, lowMinor: 150.5 })).status).toBe(400);
    expect((await post({ ...VALID, destination: 'RUH' })).status).toBe(400);
    expect((await post({ ...VALID, validTo: '31/01/2027' })).status).toBe(400);
    expect((await post({ ...VALID, source: '' })).status).toBe(400);
  });

  it('marks past rows as expired but keeps them', async () => {
    const expired = await post({ ...VALID, originCity: 'Lahore', validTo: '2020-01-01' });
    expect(expired.status).toBe(201);
    expect(expired.body.expired).toBe(true);

    const list = await request(app).get(URL).set('Cookie', jar.header());
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].expired).toBe(true);
  });

  it('updates a row and can bring an expired one back by extending validTo', async () => {
    const created = await post({ ...VALID, validTo: '2020-01-01' });
    const res = await patch(created.body.id as string, { validTo: '2030-06-30', note: 'Renewed' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ expired: false, note: 'Renewed' });
  });

  it('returns 404 for unknown and malformed ids and offers no delete', async () => {
    const created = await post(VALID);
    expect(
      (await request(app).get(`${URL}/64b7f0c2a1b2c3d4e5f60718`).set('Cookie', jar.header()))
        .status,
    ).toBe(404);
    expect((await request(app).get(`${URL}/nope`).set('Cookie', jar.header())).status).toBe(404);
    expect(
      (await request(app).delete(`${URL}/${created.body.id}`).set('Cookie', jar.header())).status,
    ).toBe(404);
  });

  it('audits create and update with before and after', async () => {
    const created = await post(VALID);
    await patch(created.body.id as string, { highMinor: 25_000_000 });
    const events = await AuditEventModel.find({ entityType: 'flightEstimate' })
      .sort({ at: 1 })
      .lean();
    expect(events.map((e) => e.action)).toEqual(['flightEstimate.create', 'flightEstimate.update']);
    expect(events[1]?.before).toMatchObject({ highMinor: 21_000_000 });
    expect(events[1]?.after).toMatchObject({ highMinor: 25_000_000 });
  });
});
