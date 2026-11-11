import { HotelViewSchema } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CookieJar, makeApp, seedHotel, seedUser, signInAs } from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { HotelModel } from './hotel.model.js';
import { findHotelByName } from './hotels.service.js';

const URL = '/api/v1/admin/hotels';

describe('hotels', () => {
  let app: Express;
  let jar: CookieJar;

  beforeEach(async () => {
    app = makeApp().app;
    jar = await signInAs(app, await seedUser({ role: 'ops' }));
  });

  const create = (body: object) => request(app).post(URL).set('Cookie', jar.header()).send(body);

  it('creates a hotel with aliases and defaults', async () => {
    const res = await create({
      city: 'makkah',
      canonicalName: '  Qila Ajiyad  ',
      aliases: ['Qila Ajyad', ' Fundaq Ajyad '],
      distanceNote: 'Shahra Ajiad',
      distanceMeters: 450,
      transport: 'walking',
    });

    expect(res.status).toBe(201);
    const hotel = HotelViewSchema.parse(res.body);
    expect(hotel.canonicalName).toBe('Qila Ajiyad');
    expect(hotel.aliases).toEqual(['Qila Ajyad', 'Fundaq Ajyad']);
    expect(hotel.active).toBe(true);
    expect(hotel.mergedIntoId).toBeNull();
    expect(hotel.starRating).toBeNull();
  });

  it('only stores a star rating when one is given', async () => {
    const without = await create({ city: 'makkah', canonicalName: 'No Stars' });
    expect(without.body.starRating).toBeNull();

    const with4 = await create({ city: 'makkah', canonicalName: 'Four Points', starRating: 4 });
    expect(with4.body.starRating).toBe(4);

    const bad = await create({ city: 'makkah', canonicalName: 'Six Stars', starRating: 6 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields).toHaveProperty('starRating');

    const cleared = await request(app)
      .patch(`${URL}/${with4.body.id}`)
      .set('Cookie', jar.header())
      .send({ starRating: null });
    expect(cleared.body.starRating).toBeNull();
  });

  it('rejects an unknown city or transport and an empty name', async () => {
    expect((await create({ city: 'jeddah', canonicalName: 'A' })).status).toBe(400);
    expect((await create({ city: 'makkah', canonicalName: '  ' })).status).toBe(400);
    expect((await create({ city: 'makkah', canonicalName: 'A', transport: 'taxi' })).status).toBe(
      400,
    );
  });

  describe('alias uniqueness', () => {
    it('rejects an alias already used by another hotel in the same city', async () => {
      await create({ city: 'makkah', canonicalName: 'Rose Platinum', aliases: ['Retaj Rawdah'] });
      const res = await create({
        city: 'makkah',
        canonicalName: 'Another Hotel',
        aliases: ['retaj  rawdah'],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('name_in_use');
      expect(res.body.error.message).toContain('Rose Platinum');
    });

    it('rejects an alias that matches another hotel canonical name, and the reverse', async () => {
      await create({ city: 'makkah', canonicalName: 'Qila Ajiyad' });
      expect(
        (await create({ city: 'makkah', canonicalName: 'Other', aliases: ['QILA AJIYAD'] })).status,
      ).toBe(409);
      await create({ city: 'makkah', canonicalName: 'Rose Platinum', aliases: ['Retaj Rawdah'] });
      expect((await create({ city: 'makkah', canonicalName: 'Retaj Rawdah' })).status).toBe(409);
    });

    it('rejects a name repeated inside one request', async () => {
      const res = await create({
        city: 'makkah',
        canonicalName: 'Dar Al Eiman',
        aliases: ['Dar al  eiman'],
      });
      expect(res.status).toBe(409);
    });

    it('allows the same name in the other city', async () => {
      await create({ city: 'makkah', canonicalName: 'Millennium', aliases: ['Millenium'] });
      const madinah = await create({
        city: 'madinah',
        canonicalName: 'Millennium',
        aliases: ['Millenium'],
      });
      expect(madinah.status).toBe(201);
    });

    it('lets a hotel keep its own names when updated', async () => {
      const hotel = await create({
        city: 'makkah',
        canonicalName: 'Qila Ajiyad',
        aliases: ['Qila Ajyad'],
      });
      const res = await request(app)
        .patch(`${URL}/${hotel.body.id}`)
        .set('Cookie', jar.header())
        .send({ aliases: ['Qila Ajyad', 'Fundaq Ajyad'], distanceNote: 'Shahra Ajiad' });
      expect(res.status).toBe(200);
      expect(res.body.aliases).toEqual(['Qila Ajyad', 'Fundaq Ajyad']);
    });

    it('still blocks a name held by a deactivated hotel', async () => {
      const hotel = await create({ city: 'makkah', canonicalName: 'Closed Hotel' });
      await request(app).post(`${URL}/${hotel.body.id}/deactivate`).set('Cookie', jar.header());
      expect((await create({ city: 'makkah', canonicalName: 'Closed Hotel' })).status).toBe(409);
    });
  });

  describe('merge', () => {
    it('moves the duplicate name and aliases into the target and deactivates it', async () => {
      const target = await create({
        city: 'makkah',
        canonicalName: 'Rose Platinum',
        aliases: ['Rose Plat'],
      });
      const duplicate = await create({
        city: 'makkah',
        canonicalName: 'Retaj Rawdah',
        aliases: ['Retaj Al Rawdah'],
      });

      const res = await request(app)
        .post(`${URL}/${duplicate.body.id}/merge`)
        .set('Cookie', jar.header())
        .send({ targetId: target.body.id });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(target.body.id);
      expect(res.body.aliases.sort()).toEqual(
        ['Retaj Al Rawdah', 'Retaj Rawdah', 'Rose Plat'].sort(),
      );

      const merged = await HotelModel.findById(duplicate.body.id).lean();
      expect(merged).not.toBeNull(); // kept, never deleted
      expect(merged?.active).toBe(false);
      expect(String(merged?.mergedIntoId)).toBe(target.body.id);

      // The old name now resolves to the surviving hotel.
      const found = await findHotelByName('makkah', 'retaj rawdah');
      expect(found?.id).toBe(target.body.id);
    });

    it('hides merged hotels from the list unless asked for', async () => {
      const target = await create({ city: 'makkah', canonicalName: 'Keep' });
      const duplicate = await create({ city: 'makkah', canonicalName: 'Fold' });
      await request(app)
        .post(`${URL}/${duplicate.body.id}/merge`)
        .set('Cookie', jar.header())
        .send({ targetId: target.body.id });

      const visible = await request(app).get(URL).set('Cookie', jar.header());
      expect(visible.body.items.map((h: { canonicalName: string }) => h.canonicalName)).toEqual([
        'Keep',
      ]);
      const all = await request(app).get(`${URL}?includeInactive=true`).set('Cookie', jar.header());
      expect(all.body.total).toBe(2);
    });

    it('refuses to merge into itself, across cities, or into a merged hotel', async () => {
      const a = await create({ city: 'makkah', canonicalName: 'A' });
      const b = await create({ city: 'makkah', canonicalName: 'B' });
      const madinah = await create({ city: 'madinah', canonicalName: 'C' });

      const merge = (fromId: string, targetId: string) =>
        request(app).post(`${URL}/${fromId}/merge`).set('Cookie', jar.header()).send({ targetId });

      expect((await merge(a.body.id, a.body.id)).status).toBe(400);
      expect((await merge(a.body.id, madinah.body.id)).status).toBe(400);
      expect((await merge(a.body.id, '64b7f0c2a1b2c3d4e5f60718')).status).toBe(404);

      await merge(a.body.id, b.body.id);
      const chained = await merge(b.body.id, a.body.id); // a is already merged away
      expect(chained.status).toBe(400);
    });

    it('audits the merge on both hotels', async () => {
      const target = await create({ city: 'makkah', canonicalName: 'Target' });
      const duplicate = await create({ city: 'makkah', canonicalName: 'Duplicate' });
      await request(app)
        .post(`${URL}/${duplicate.body.id}/merge`)
        .set('Cookie', jar.header())
        .send({ targetId: target.body.id });

      const events = await AuditEventModel.find({ action: 'hotel.merge' }).lean();
      expect(events).toHaveLength(2);
      const ids = events.map((e) => String(e.entityId)).sort();
      expect(ids).toEqual([target.body.id, duplicate.body.id].sort());
    });
  });

  it('filters by city and hides inactive hotels by default', async () => {
    await seedHotel({ city: 'makkah', canonicalName: 'Makkah One' });
    await seedHotel({ city: 'madinah', canonicalName: 'Madinah One' });
    await seedHotel({ city: 'madinah', canonicalName: 'Closed', active: false });

    const madinah = await request(app).get(`${URL}?city=madinah`).set('Cookie', jar.header());
    expect(madinah.body.items.map((h: { canonicalName: string }) => h.canonicalName)).toEqual([
      'Madinah One',
    ]);
  });

  it('lets sales read but not write', async () => {
    const salesJar = await signInAs(app, await seedUser({ role: 'sales' }));
    expect((await request(app).get(URL).set('Cookie', salesJar.header())).status).toBe(200);
    const write = await request(app)
      .post(URL)
      .set('Cookie', salesJar.header())
      .send({ city: 'makkah', canonicalName: 'Nope' });
    expect(write.status).toBe(403);
  });
});

describe('merged hotels', () => {
  it('allows several hotels in one city to be merged away', async () => {
    const { app } = makeApp();
    const jar = await signInAs(app, await seedUser({ role: 'ops' }));
    const make = (canonicalName: string) =>
      request(app).post(URL).set('Cookie', jar.header()).send({ city: 'makkah', canonicalName });
    const keep = await make('Keep');
    const first = await make('First Duplicate');
    const second = await make('Second Duplicate');

    for (const duplicate of [first, second]) {
      const res = await request(app)
        .post(`${URL}/${duplicate.body.id}/merge`)
        .set('Cookie', jar.header())
        .send({ targetId: keep.body.id });
      expect(res.status).toBe(200);
    }
    const all = await request(app).get(`${URL}?includeInactive=true`).set('Cookie', jar.header());
    expect(all.body.total).toBe(3);
    expect(
      all.body.items.filter((h: { mergedIntoId: string | null }) => h.mergedIntoId),
    ).toHaveLength(2);
  });
});
