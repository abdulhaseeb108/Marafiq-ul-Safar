/**
 * The pricing service and public API against a database: the WMT sheet is
 * uploaded, read and published through the admin API, then priced through
 * POST /public/calculate. Covers T1 and T7 end to end.
 */
import {
  CalculationResultSchema,
  type CalculateInputBody,
  type PublicHotel,
  type SourceDocumentView,
} from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CookieJar,
  FILE_B,
  makeSheetApp,
  seedFlightEstimate,
  seedSheetHotels,
  seedSupplier,
  seedUser,
  signInAs,
  uploadAndExtract,
} from '../../test/helpers.js';
import { HotelModel } from '../hotels/hotel.model.js';
import { SettingsModel } from '../settings/settings.model.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { CalculationModel, ImmutableCalculationError } from './calculation.model.js';
import { getCalculation, saveCalculation } from './pricing.service.js';

const CALCULATE = '/api/v1/public/calculate';
const HOTELS = '/api/v1/public/hotels';
const PACKS = '/api/v1/admin/rate-packages';

let app: Express;
let ops: CookieJar;
let admin: CookieJar;
let supplierId: string;
let doc: SourceDocumentView;

const hotelId = async (name: string) =>
  String((await HotelModel.findOne({ canonicalName: name }).lean())?._id);

const packNamed = (source: SourceDocumentView, name: string) => {
  const pack = source.packages.find((p) => p.packName === name);
  if (!pack) throw new Error(`no pack ${name}`);
  return pack.id;
};

const publish = (packageId: string) =>
  request(app)
    .post(`${PACKS}/${packageId}/publish`)
    .set('Cookie', ops.header())
    .send({ acknowledgeWarnings: true });

async function setFx(rate = '75.00') {
  const res = await request(app)
    .post('/api/v1/admin/fx')
    .set('Cookie', admin.header())
    .send({ rate });
  expect(res.status).toBe(201);
}

async function publishFileA() {
  for (const name of ['Ramadan Pack 01', 'Ramadan Pack 02', 'Shawal']) {
    expect((await publish(packNamed(doc, name))).status).toBe(200);
  }
}

async function t1(): Promise<CalculateInputBody> {
  return {
    departureCity: 'Islamabad',
    arrivalDate: '2027-02-08',
    nightsMakkah: 3,
    nightsMadinah: 2,
    order: 'makkah_first',
    travelers: { adults: 4 },
    rooms: [{ occupancy: 'quad', persons: 4 }],
    hotels: {
      makkah: await hotelId('Qila Ajiyad'),
      madinah: await hotelId('Waqar Salmiya/Jood Marjan'),
    },
    visa: 'direct',
    flight: 'estimate',
  };
}

const calculate = (body: object) => request(app).post(CALCULATE).send(body);

beforeEach(async () => {
  ({ app } = makeSheetApp());
  ops = await signInAs(app, await seedUser({ role: 'ops' }));
  admin = await signInAs(app, await seedUser({ role: 'admin' }));
  supplierId = (await seedSupplier({ name: 'Waqar-e-Madina Group (WMT)' })).id;
  await SupplierModel.updateOne(
    { _id: supplierId },
    {
      contactName: 'Private Contact',
      phone: '+923000000000',
      email: 'private@supplier.test',
      notes: 'INTERNAL NOTE',
    },
  );
  await seedSheetHotels();
  doc = await uploadAndExtract(app, ops, supplierId);
});

describe('POST /public/calculate', () => {
  it('T1 through the API: SAR 3,232, SAR 808 per person, PKR 242,400, partial', async () => {
    await setFx();
    await publishFileA();
    const res = await calculate(await t1());

    expect(res.status).toBe(200);
    const result = CalculationResultSchema.parse(res.body);
    expect(result.totals).toMatchObject({
      groupMinorSAR: 323_200,
      perPersonMinorSAR: 80_800,
      groupMinorPKR: 24_240_000,
      isPartial: true,
    });
    expect(result.missing.map((m) => m.code)).toEqual(['flight_no_estimate']);
    expect(result.lineItems[0]).toMatchObject({
      label: 'Qila Ajiyad, 3 nights × 4 persons × SAR 50',
      source: {
        supplierName: 'Waqar-e-Madina Group (WMT)',
        packName: 'Ramadan Pack 01',
        issueDate: '2026-10-27',
        version: 1,
      },
    });
    // Nothing is saved by calculating.
    expect(await CalculationModel.countDocuments()).toBe(0);
  });

  it('needs no sign-in and never returns supplier contact details or notes', async () => {
    await setFx();
    await publishFileA();
    const res = await calculate(await t1());
    const text = JSON.stringify(res.body);
    for (const secret of [
      'Private Contact',
      '+923000000000',
      'private@supplier.test',
      'INTERNAL NOTE',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('uses only published rates: draft packs price nothing', async () => {
    await setFx();
    const res = await calculate(await t1());
    expect(res.status).toBe(200);
    expect(res.body.lineItems).toEqual([]);
    expect(res.body.missing.map((m: { code: string }) => m.code)).toEqual([
      'hotel_no_rate',
      'hotel_no_rate',
      'visa_no_rate',
      'flight_no_estimate',
    ]);
  });

  it('includes a staff flight estimate as a range', async () => {
    await setFx();
    await publishFileA();
    await seedFlightEstimate({
      originCity: 'Islamabad',
      destination: 'JED',
      validTo: '2099-01-01',
    });
    const res = await calculate(await t1());
    expect(res.body.totals.range).toMatchObject({ groupLowMinorPKR: 24_240_000 + 60_000_000 });
    expect(res.body.missing).toEqual([]);
  });

  it('uses the markup in Settings', async () => {
    await setFx();
    await publishFileA();
    await SettingsModel.create({ singleton: 'settings', markupPercent: 10 });
    const res = await calculate(await t1());
    expect(res.body.totals.groupMinorSAR).toBe(355_520);
    expect(res.body.markupPercent).toBe(10);
  });

  it('answers 503 "Request a quote" when no FX rate is set, instead of guessing', async () => {
    await publishFileA();
    const res = await calculate(await t1());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('prices_unavailable');
  });

  it('rejects invalid inputs with one message per field', async () => {
    await setFx();
    const body = await t1();
    const mismatch = await calculate({ ...body, rooms: [{ occupancy: 'quad', persons: 3 }] });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.fields.rooms).toMatch(/needs a place/);

    const tooMany = await calculate({ ...body, rooms: [{ occupancy: 'double', persons: 4 }] });
    expect(tooMany.body.error.fields['rooms.0.persons']).toBe('More people than beds in this room');

    const past = await calculate({ ...body, arrivalDate: '2020-01-01' });
    expect(past.status).toBe(400);
    expect(past.body.error.fields.arrivalDate).toBe('Choose today or a later date');

    const noHotel = await calculate({ ...body, hotels: { makkah: body.hotels.makkah } });
    expect(noHotel.body.error.fields['hotels.madinah']).toBe('Choose a hotel');

    // Fields we must never collect are dropped, not stored or echoed.
    await publishFileA();
    const extra = await calculate({
      ...body,
      passportNumber: 'AB1234567',
      cnic: '12345-1234567-1',
    });
    expect(extra.status).toBe(200);
    expect(JSON.stringify(extra.body)).not.toMatch(/AB1234567|12345-1234567-1/);
  });
});

describe('saved calculations are snapshots', () => {
  it('T7: publishing a new pack version does not change a saved calculation', async () => {
    await setFx();
    await publishFileA();
    const first = await calculate(await t1());
    const savedId = await saveCalculation(CalculationResultSchema.parse(first.body));
    const before = await getCalculation(savedId);

    // A newer sheet replaces Ramadan Pack 01 with a higher Qila Ajiyad quad rate.
    const newer = await uploadAndExtract(app, ops, supplierId, FILE_B);
    const replacement = packNamed(newer, 'Ramadan Pack 01');
    await request(app)
      .patch(`${PACKS}/${replacement}`)
      .set('Cookie', ops.header())
      .send({
        supersedesId: packNamed(doc, 'Ramadan Pack 01'),
      });
    const detail = await request(app).get(`${PACKS}/${replacement}`).set('Cookie', ops.header());
    const qila = detail.body.rates.find(
      (r: { hotelName: string }) => r.hotelName === 'Qila Ajiyad',
    );
    const edit = await request(app)
      .patch(`/api/v1/admin/hotel-rates/${qila.id}`)
      .set('Cookie', ops.header())
      .send({ perPersonMinor: { quad: 6000 } });
    expect(edit.status).toBe(200);
    const published = await publish(replacement);
    expect(published.body).toMatchObject({ status: 'published', version: 2 });

    const reloaded = await getCalculation(savedId);
    expect(reloaded).toEqual(before);
    expect(reloaded.totals.groupMinorSAR).toBe(323_200);
    expect(reloaded.rateVersionSnapshot[0]).toMatchObject({ version: 1 });

    const fresh = await calculate(await t1());
    expect(fresh.body.totals.groupMinorSAR).toBe(323_200 + 12_000);
    expect(fresh.body.hash).not.toBe(before.hash);
  });

  it('a saved calculation cannot be updated', async () => {
    await setFx();
    await publishFileA();
    const res = await calculate(await t1());
    const savedId = await saveCalculation(CalculationResultSchema.parse(res.body));

    await expect(
      CalculationModel.updateOne({ _id: savedId }, { markupPercent: 50 }),
    ).rejects.toThrow(ImmutableCalculationError);
    await expect(
      CalculationModel.findOneAndUpdate({ _id: savedId }, { hash: 'x' }),
    ).rejects.toThrow(ImmutableCalculationError);
    const doc = await CalculationModel.findById(savedId);
    doc?.set('markupPercent', 50);
    await expect(doc?.save()).rejects.toThrow(ImmutableCalculationError);
    expect((await getCalculation(savedId)).markupPercent).toBe(0);
  });

  it('the same inputs and rate versions give the same hash', async () => {
    await setFx();
    await publishFileA();
    const a = await calculate(await t1());
    const b = await calculate(await t1());
    expect(a.body.hash).toBe(b.body.hash);
  });
});

describe('GET /public/hotels', () => {
  const list = async (query = '') =>
    (await request(app).get(`${HOTELS}${query}`)).body.items as PublicHotel[];

  it('lists nothing until a pack is published', async () => {
    await setFx();
    expect(await list()).toEqual([]);
  });

  it('lists published hotels with the lowest published price, filtered by city', async () => {
    await setFx();
    await publishFileA();
    const all = await list();
    expect(all).toHaveLength(29);

    const makkah = await list('?city=Makkah');
    expect(makkah.every((h) => h.city === 'makkah')).toBe(true);
    const madinah = await list('?city=Madinah');
    expect(madinah.length).toBeGreaterThan(0);
    expect(madinah.every((h) => h.city === 'madinah')).toBe(true);
    const qila = makkah.find((h) => h.name === 'Qila Ajiyad');
    expect(qila).toMatchObject({
      distanceMeters: 1100,
      ratesFrom: '2027-02-06',
      ratesTo: '2027-04-06',
      // Shawal quint: SAR 19 = PKR 1,425.
      fromPerPerson: {
        minorSAR: 1900,
        minorPKR: 142_500,
        packName: 'Shawal',
        supplierName: 'Waqar-e-Madina Group (WMT)',
      },
      fromPerRoom: null,
      onRequestOnly: false,
    });
    expect(makkah.find((h) => h.name === 'Voco')).toMatchObject({
      onRequestOnly: true,
      fromPerPerson: null,
    });
    expect(makkah.find((h) => h.name.startsWith('Akabir'))?.fromPerRoom).toMatchObject({
      minorSAR: 32_500,
    });

    const text = JSON.stringify(all);
    expect(text).not.toMatch(/Private Contact|\+923000000000|private@supplier\.test|INTERNAL NOTE/);
  });

  it('shows PKR only when Settings hide supplier SAR rates', async () => {
    await setFx();
    await publishFileA();
    await SettingsModel.create({ singleton: 'settings', showSupplierRates: false });
    const qila = (await list('?city=makkah')).find((h) => h.name === 'Qila Ajiyad');
    expect(qila?.fromPerPerson).toMatchObject({ minorSAR: null, minorPKR: 142_500 });
  });

  it('rejects an unknown city', async () => {
    const res = await request(app).get(`${HOTELS}?city=taif`);
    expect(res.status).toBe(400);
  });
});
