/**
 * A pricing context built straight from docs/seed/waqar-sample.json, for the
 * pure engine tests: the WMT sheet as if every pack of one file were published.
 * Sheet amounts are whole SAR; the engine works in halalas.
 */
import { normalizeName } from '../lib/names.js';
import type { CtxHotel, CtxPackage, PricingContext } from '../modules/pricing/engine.js';
import { FILE_A, loadSheetFixture } from './helpers.js';

export const SUPPLIER_ID = 'a00000000000000000000001';
export const SUPPLIER_NAME = 'Waqar-e-Madina Group (WMT)';
/** 2 Nov 2026: before every pack on the sheet, so no pack has ended. */
export const NOW = new Date('2026-11-02T09:00:00.000Z');

const hex = (prefix: string, n: number) => `${prefix}${n.toString(16).padStart(23, '0')}`;
const toMinor = (major: number | null | undefined) =>
  major === null || major === undefined ? null : Math.round(major * 100);

interface FixtureRow {
  city: 'makkah' | 'madinah';
  name: string;
  aliasesPrinted: string[];
  pricingMode: 'derived_per_person' | 'flat_per_room' | 'on_request';
  room: number | null;
  perPerson: {
    quint: number | null;
    quad: number | null;
    triple: number | null;
    double: number | null;
  };
}

interface FixturePack {
  sourceFile: string;
  packName: string;
  nightFrom: string;
  nightTo: string;
  issueDate: string;
  visa: {
    directPerPerson: number | null;
    indirectByGroupSize: Record<'1' | '2' | '3' | '4', number | null>;
    infant: number | null;
  };
  hotels: FixtureRow[];
}

export function fixtureHotels(): CtxHotel[] {
  return loadSheetFixture().hotels.map((hotel, index) => ({
    id: hex('b', index + 1),
    city: hotel.city,
    name: hotel.name,
    distanceMeters: hotel.distanceMeters ?? null,
  }));
}

export function hotelId(name: string): string {
  const hotel = fixtureHotels().find((h) => h.name === name);
  if (!hotel) throw new Error(`no fixture hotel ${name}`);
  return hotel.id;
}

export function fixturePackages(fileName = FILE_A): CtxPackage[] {
  const masters = loadSheetFixture().hotels;
  const hotels = fixtureHotels();
  const match = (row: FixtureRow) => {
    const names = [row.name, ...row.aliasesPrinted].map(normalizeName);
    const index = masters.findIndex(
      (m) =>
        m.city === row.city &&
        [m.name, ...m.aliasesPrinted].map(normalizeName).some((n) => names.includes(n)),
    );
    if (index < 0) throw new Error(`no master hotel for ${row.name}`);
    return hotels[index]?.id as string;
  };
  const packs = (loadSheetFixture().extractions as unknown as FixturePack[]).filter(
    (p) => p.sourceFile === fileName,
  );
  return packs.map((pack, index) => ({
    id: hex('c', index + 1),
    version: 1,
    supplierId: SUPPLIER_ID,
    supplierName: SUPPLIER_NAME,
    packName: pack.packName,
    nightFrom: pack.nightFrom,
    nightTo: pack.nightTo,
    issueDate: pack.issueDate,
    publishedAt: '2026-11-01T00:00:00.000Z',
    rates: pack.hotels.map((row) => ({
      hotelId: match(row),
      pricingMode: row.pricingMode,
      roomPriceMinor: toMinor(row.room),
      perPersonMinor: {
        quint: toMinor(row.perPerson.quint),
        quad: toMinor(row.perPerson.quad),
        triple: toMinor(row.perPerson.triple),
        double: toMinor(row.perPerson.double),
      },
    })),
    visa: {
      directPerPersonMinor: toMinor(pack.visa.directPerPerson),
      indirectByGroupSize: {
        '1': toMinor(pack.visa.indirectByGroupSize['1']),
        '2': toMinor(pack.visa.indirectByGroupSize['2']),
        '3': toMinor(pack.visa.indirectByGroupSize['3']),
        '4': toMinor(pack.visa.indirectByGroupSize['4']),
      },
      infantMinor: toMinor(pack.visa.infant),
    },
  }));
}

/** docs/03 section 7: FX 75.00 PKR per SAR, markup 0. */
export function fixtureContext(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    now: NOW,
    settings: {
      markupPercent: 0,
      estimateExpiryHours: 72,
      childAsAdult: true,
      infantHotelCharge: 'none',
    },
    fx: { rate: '75.00', effectiveAt: new Date('2026-11-01T00:00:00.000Z') },
    hotels: fixtureHotels(),
    packages: fixturePackages(),
    flightEstimates: [],
    ...overrides,
  };
}
