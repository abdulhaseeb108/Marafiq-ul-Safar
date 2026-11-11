import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditEventModel } from '../modules/audit/audit.model.js';
import { FxRateModel } from '../modules/fx/fx.model.js';
import { HotelModel } from '../modules/hotels/hotel.model.js';
import { SettingsModel } from '../modules/settings/settings.model.js';
import { SupplierModel } from '../modules/suppliers/supplier.model.js';
import { WAQAR_SUPPLIER_NAME, runSeed } from './seed.js';

/** A small stand-in for docs/seed/waqar-sample.json in the shape of docs/03 section 3. */
const FIXTURE = {
  supplierName: WAQAR_SUPPLIER_NAME,
  packName: 'Ramadan Pack 01',
  hotels: [
    {
      city: 'makkah',
      name: 'Qila Ajiyad',
      aliasesPrinted: ['Qila Ajyad'],
      distanceText: 'Shahra Ajiad, 450 m',
      distanceMeters: 450,
      transportText: 'Walking distance',
    },
    {
      city: 'makkah',
      name: 'Rose Platinum',
      aliasesPrinted: ['Retaj Rawdah'],
      distanceText: 'Shuttle service',
      transportText: 'Shuttle every 30 minutes',
    },
    { city: 'madinah', name: 'Waqar Salmiya', aliasesPrinted: [] },
  ],
};

function fixtureFile(data: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'msf-seed-')), 'waqar-sample.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe('seed', () => {
  it('creates the supplier, settings, an FX rate and the hotels', async () => {
    const result = await runSeed({ fixturePath: fixtureFile(FIXTURE), env: {} });

    expect(result.supplier).toBe('created');
    expect(result.hotelsCreated).toBe(3);

    const supplier = await SupplierModel.findOne({ name: WAQAR_SUPPLIER_NAME }).lean();
    expect(supplier?.type).toBe('hotel_operator');

    const settings = await SettingsModel.findOne().lean();
    expect(settings).toMatchObject({ markupPercent: 0, estimateExpiryHours: 72 });

    const fx = await FxRateModel.findOne().lean();
    expect(fx).toMatchObject({ base: 'SAR', quote: 'PKR', rate: '75.00' });

    const rose = await HotelModel.findOne({ canonicalName: 'Rose Platinum' }).lean();
    expect(rose?.aliases).toEqual(['Retaj Rawdah']);
    expect(rose?.city).toBe('makkah');
    expect(rose?.transport).toBe('shuttle');

    const qila = await HotelModel.findOne({ canonicalName: 'Qila Ajiyad' }).lean();
    expect(qila).toMatchObject({ distanceMeters: 450, transport: 'walking' });
    expect(await HotelModel.countDocuments({ city: 'madinah' })).toBe(1);
  });

  it('is idempotent: running twice changes nothing', async () => {
    const path = fixtureFile(FIXTURE);
    await runSeed({ fixturePath: path, env: {} });
    const before = await HotelModel.find().sort({ canonicalName: 1 }).lean();

    const second = await runSeed({ fixturePath: path, env: {} });
    expect(second).toMatchObject({ supplier: 'exists', hotelsCreated: 0, fx: 'exists' });

    expect(await SupplierModel.countDocuments()).toBe(1);
    expect(await SettingsModel.countDocuments()).toBe(1);
    expect(await FxRateModel.countDocuments()).toBe(1);
    expect(await HotelModel.find().sort({ canonicalName: 1 }).lean()).toEqual(before);
  });

  it('adds only the hotels that are missing when the fixture grows', async () => {
    await runSeed({ fixturePath: fixtureFile(FIXTURE), env: {} });
    const grown = {
      ...FIXTURE,
      hotels: [...FIXTURE.hotels, { city: 'makkah', name: 'Fundaq Bilal', aliasesPrinted: [] }],
    };
    const result = await runSeed({ fixturePath: fixtureFile(grown), env: {} });
    expect(result.hotelsCreated).toBe(1);
    expect(await HotelModel.countDocuments()).toBe(4);
  });

  it('matches an existing hotel by its alias, not only by its name', async () => {
    await runSeed({ fixturePath: fixtureFile(FIXTURE), env: {} });
    // The sheet now prints the old name as the main one.
    const renamed = {
      ...FIXTURE,
      hotels: [{ city: 'makkah', name: 'Retaj Rawdah', aliasesPrinted: ['Rose Platinum'] }],
    };
    const result = await runSeed({ fixturePath: fixtureFile(renamed), env: {} });
    expect(result.hotelsCreated).toBe(0);
    expect(await HotelModel.countDocuments({ city: 'makkah' })).toBe(2);
  });

  it('uses SEED_FX_RATE when given', async () => {
    await runSeed({ fixturePath: fixtureFile(FIXTURE), env: { SEED_FX_RATE: '74.25' } });
    expect((await FxRateModel.findOne().lean())?.rate).toBe('74.25');
  });

  it('refuses an invalid SEED_FX_RATE instead of guessing', async () => {
    await expect(
      runSeed({ fixturePath: fixtureFile(FIXTURE), env: { SEED_FX_RATE: 'abc' } }),
    ).rejects.toThrow(/SEED_FX_RATE/);
    expect(await FxRateModel.countDocuments()).toBe(0);
  });

  it('seeds the rest and reports the gap when the hotel fixture is missing', async () => {
    const result = await runSeed({ fixturePath: '/does/not/exist.json', env: {} });
    expect(result.hotels).toBe('fixture_missing');
    expect(result.hotelsCreated).toBe(0);
    expect(await SupplierModel.countDocuments()).toBe(1);
    expect(await FxRateModel.countDocuments()).toBe(1);
  });

  it('refuses a fixture that is not valid JSON or has the wrong shape', async () => {
    const badJson = join(mkdtempSync(join(tmpdir(), 'msf-seed-')), 'waqar-sample.json');
    writeFileSync(badJson, '{not json');
    await expect(runSeed({ fixturePath: badJson, env: {} })).rejects.toThrow();

    const wrongShape = fixtureFile({ hotels: [{ city: 'jeddah', name: 'X' }] });
    await expect(runSeed({ fixturePath: wrongShape, env: {} })).rejects.toThrow();
  });

  it('records what it created as system audit events', async () => {
    await runSeed({ fixturePath: fixtureFile(FIXTURE), env: {} });
    const events = await AuditEventModel.find({ actorRole: 'system' }).lean();
    const actions = events.map((e) => e.action);
    expect(actions).toContain('supplier.create');
    expect(actions).toContain('fx.create');
    expect(actions.filter((a) => a === 'hotel.create')).toHaveLength(3);
    expect(events.every((e) => !e.actorId)).toBe(true);
  });
});
