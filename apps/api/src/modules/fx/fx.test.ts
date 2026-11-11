import { FxRateViewSchema } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, makeApp, seedUser, signInAs } from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { FxRateModel } from './fx.model.js';
import { getCurrentFx } from './fx.service.js';

const URL = '/api/v1/admin/fx';

describe('FX rates', () => {
  let app: Express;
  let jar: CookieJar;
  let adminId: string;

  beforeEach(async () => {
    app = makeApp().app;
    const admin = await seedUser({ role: 'admin' });
    adminId = admin.id;
    jar = await signInAs(app, admin);
  });

  const post = (body: object) => request(app).post(URL).set('Cookie', jar.header()).send(body);

  it('adds a rate and records who set it', async () => {
    const res = await post({ rate: '74.50' });
    expect(res.status).toBe(201);
    const row = FxRateViewSchema.parse(res.body);
    expect(row).toMatchObject({ base: 'SAR', quote: 'PKR', rate: '74.50', setBy: adminId });
    expect(row.setByName).toBe('Test admin');
  });

  it('rejects zero, negative, non-numeric and over-precise rates', async () => {
    for (const rate of ['0', '0.00', '-75', 'abc', '75.123456', '']) {
      const res = await post({ rate });
      expect(res.status, rate).toBe(400);
      expect(res.body.error.fields).toHaveProperty('rate');
    }
  });

  describe('history', () => {
    it('never changes an existing row when a new rate is added', async () => {
      const first = await post({ rate: '74.50' });
      const before = await FxRateModel.findById(first.body.id).lean();
      await post({ rate: '76.00' });
      const after = await FxRateModel.findById(first.body.id).lean();
      expect(after).toEqual(before);
      expect(await FxRateModel.countDocuments()).toBe(2);
    });

    it('returns history newest first with paging', async () => {
      await post({ rate: '74.00' });
      await post({ rate: '75.00' });
      await post({ rate: '76.00' });
      const res = await request(app).get(`${URL}?limit=2`).set('Cookie', jar.header());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 2, total: 3 });
      expect(res.body.items.map((r: { rate: string }) => r.rate)).toEqual(['76.00', '75.00']);
    });

    it('offers no way to edit or delete a row', async () => {
      const created = await post({ rate: '75.00' });
      const id = created.body.id as string;
      for (const method of ['patch', 'put', 'delete'] as const) {
        const res = await request(app)
          [method](`${URL}/${id}`)
          .set('Cookie', jar.header())
          .send({ rate: '1.00' });
        expect(res.status, method).toBe(404);
      }
      expect((await FxRateModel.findById(id).lean())?.rate).toBe('75.00');
    });
  });

  describe('large change confirmation', () => {
    it('allows any rate when there is no previous one', async () => {
      expect((await post({ rate: '500.00' })).status).toBe(201);
    });

    it('blocks a change of more than 30% without confirmLargeChange', async () => {
      await post({ rate: '75.00' });
      const res = await post({ rate: '100.00' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('large_fx_change');
      expect(res.body.error.message).toContain('75.00');
      expect(await FxRateModel.countDocuments()).toBe(1); // nothing stored
    });

    it('accepts the same change with confirmLargeChange', async () => {
      await post({ rate: '75.00' });
      const res = await post({ rate: '100.00', confirmLargeChange: true });
      expect(res.status).toBe(201);
      expect((await getCurrentFx())?.rate).toBe('100.00');
    });

    it('treats exactly 30% as acceptable and just over as a large change', async () => {
      await post({ rate: '100.00' });
      expect((await post({ rate: '130.00' })).status).toBe(201); // +30%
      expect((await post({ rate: '169.01' })).status).toBe(409); // +30.0076%
      expect((await post({ rate: '91.00' })).status).toBe(201); // -30%
      expect((await post({ rate: '63.69' })).status).toBe(409); // -30.01%
    });

    it('compares against the latest rate by effective date, not insertion order', async () => {
      await post({ rate: '75.00', effectiveAt: '2026-11-01T00:00:00.000Z' });
      await post({ rate: '76.00', effectiveAt: '2026-11-10T00:00:00.000Z' });
      // Backdated row: still compared against the newest effective rate (76.00).
      const res = await post({ rate: '110.00', effectiveAt: '2026-11-05T00:00:00.000Z' });
      expect(res.status).toBe(409);
    });
  });

  describe('getCurrentFx', () => {
    it('returns null when no rate has been set', async () => {
      expect(await getCurrentFx()).toBeNull();
    });

    it('picks the latest row effective at the given time, ignoring future rows', async () => {
      await post({ rate: '70.00', effectiveAt: '2026-01-01T00:00:00.000Z' });
      await post({ rate: '75.00', effectiveAt: '2026-06-01T00:00:00.000Z' });
      await post({ rate: '80.00', effectiveAt: '2099-01-01T00:00:00.000Z' });

      expect((await getCurrentFx(new Date('2026-03-01T00:00:00.000Z')))?.rate).toBe('70.00');
      expect((await getCurrentFx(new Date('2026-07-01T00:00:00.000Z')))?.rate).toBe('75.00');
      expect((await getCurrentFx())?.rate).toBe('75.00'); // the 2099 row is not in effect
      expect(await getCurrentFx(new Date('2025-01-01T00:00:00.000Z'))).toBeNull();
    });
  });

  it('audits every rate that is added, and nothing else', async () => {
    await post({ rate: '75.00' });
    await post({ rate: '76.00' });
    const events = await AuditEventModel.find({ entityType: 'fxRate' }).sort({ at: 1 }).lean();
    expect(events.map((e) => e.action)).toEqual(['fx.create', 'fx.create']);
    expect(events[1]?.before).toMatchObject({ rate: '75.00' });
    expect(events[1]?.after).toMatchObject({ rate: '76.00' });
    expect(String(events[0]?.actorId)).toBe(adminId);
  });
});
