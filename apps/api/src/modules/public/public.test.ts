import { PublicConfigSchema } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CookieJar,
  makeApp,
  seedFlightEstimate,
  seedSupplier,
  seedUser,
  signInAs,
} from '../../test/helpers.js';

const URL = '/api/v1/public/config';

describe('GET /public/config', () => {
  let app: Express;
  let adminJar: CookieJar;

  beforeEach(async () => {
    app = makeApp().app;
    adminJar = await signInAs(app, await seedUser({ role: 'admin' }));
  });

  it('needs no sign-in and returns defaults on a fresh database', async () => {
    const res = await request(app).get(URL);
    expect(res.status).toBe(200);
    const config = PublicConfigSchema.parse(res.body);
    expect(config).toMatchObject({
      languages: ['en', 'ur'],
      fx: null,
      markupApplied: false,
      showSupplierRates: true,
      departureCities: [],
    });
  });

  it('shows the current FX rate once one is set', async () => {
    await request(app)
      .post('/api/v1/admin/fx')
      .set('Cookie', adminJar.header())
      .send({ rate: '75.00' });
    const res = await request(app).get(URL);
    expect(res.body.fx.rate).toBe('75.00');
    expect(res.body.fx.effectiveAt).toBeDefined();
  });

  it('ignores a rate that is not in effect yet', async () => {
    await request(app)
      .post('/api/v1/admin/fx')
      .set('Cookie', adminJar.header())
      .send({ rate: '80.00', effectiveAt: '2099-01-01T00:00:00.000Z' });
    expect((await request(app).get(URL)).body.fx).toBeNull();
  });

  it('lists only departure cities whose estimate has not expired, once each, sorted', async () => {
    await seedFlightEstimate({ originCity: 'Lahore', validTo: '2030-01-01' });
    await seedFlightEstimate({ originCity: 'Islamabad', validTo: '2030-01-01' });
    await seedFlightEstimate({
      originCity: 'Islamabad',
      destination: 'MED',
      validTo: '2030-01-01',
    });
    await seedFlightEstimate({ originCity: 'Karachi', validTo: '2020-01-01' }); // expired

    const res = await request(app).get(URL);
    expect(res.body.departureCities).toEqual(['Islamabad', 'Lahore']);
  });

  it('reports markup as a flag and never the percentage', async () => {
    await request(app)
      .put('/api/v1/admin/settings')
      .set('Cookie', adminJar.header())
      .send({ markupPercent: 7.5, showSupplierRates: false });

    const res = await request(app).get(URL);
    expect(res.body.markupApplied).toBe(true);
    expect(res.body.showSupplierRates).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('7.5');
    expect(res.body).not.toHaveProperty('markupPercent');
  });

  it('never exposes supplier contacts, internal notes or staff details', async () => {
    await seedSupplier({ name: 'Waqar-e-Madina Group (WMT)' });
    const staff = await seedUser({ role: 'sales', email: 'sales.person@example.com' });
    await seedFlightEstimate({ originCity: 'Islamabad', validTo: '2030-01-01' });
    await request(app)
      .post('/api/v1/admin/flight-estimates')
      .set('Cookie', adminJar.header())
      .send({
        originCity: 'Peshawar',
        destination: 'JED',
        lowMinor: 15_000_000,
        highMinor: 21_000_000,
        validTo: '2030-01-01',
        note: 'internal: partner margin is thin here',
        source: 'partner quote 2026-11-05',
      });

    const res = await request(app).get(URL);
    const body = JSON.stringify(res.body);
    for (const leak of [
      'Waqar',
      staff.email,
      'internal:',
      'partner quote',
      'lowMinor',
      'validTo',
    ]) {
      expect(body, leak).not.toContain(leak);
    }
    // Only the documented keys are present: nothing can slip in unnoticed.
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(PublicConfigSchema.shape).sort());
    expect(res.body.departureCities).toEqual(['Islamabad', 'Peshawar']);
  });
});
