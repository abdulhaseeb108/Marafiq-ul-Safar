/** API answers for the browser tests: the T1 example from docs/03 section 7. */
import type { CalculationResult, PublicConfig, PublicHotel } from '@marafiq/shared';

const addDays = (date: string, days: number) => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

/** A month from today, so the date is always in the future. */
export const ARRIVAL = addDays(new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10), 30);
export const MAKKAH = '64b7f0c2a1b2c3d4e5f60001';
export const MADINAH = '64b7f0c2a1b2c3d4e5f60002';
const PACK = '64b7f0c2a1b2c3d4e5f600a1';
const SUPPLIER = '64b7f0c2a1b2c3d4e5f600b1';

export const config: PublicConfig = {
  languages: ['en', 'ur'],
  fx: { rate: '75.00', effectiveAt: new Date('2026-11-01T00:00:00Z') },
  markupApplied: false,
  showSupplierRates: true,
  responseTimeText: '',
  departureCities: ['Islamabad', 'Lahore'],
};

const from = {
  supplierName: 'Waqar-e-Madina Group (WMT)',
  packName: 'Shawal',
  issueDate: '2026-10-27',
};

export const hotels: PublicHotel[] = [
  {
    id: MAKKAH,
    city: 'makkah',
    name: 'Qila Ajiyad',
    distanceMeters: 1100,
    distanceNote: '',
    transport: 'shuttle',
    ratesFrom: '2027-02-06',
    ratesTo: '2027-04-06',
    fromPerPerson: { ...from, minorSAR: 1900, minorPKR: 142_500 },
    fromPerRoom: null,
    onRequestOnly: false,
  },
  {
    id: MADINAH,
    city: 'madinah',
    name: 'Waqar Salmiya/Jood Marjan',
    distanceMeters: 450,
    distanceNote: '',
    transport: 'walking',
    ratesFrom: '2027-02-06',
    ratesTo: '2027-04-06',
    fromPerPerson: { ...from, minorSAR: 3000, minorPKR: 225_000 },
    fromPerRoom: null,
    onRequestOnly: false,
  },
];

const source = {
  packageId: PACK,
  version: 1,
  packName: 'Ramadan Pack 01',
  supplierId: SUPPLIER,
  supplierName: 'Waqar-e-Madina Group (WMT)',
  issueDate: '2026-10-27',
  nightFrom: '2027-02-06',
  nightTo: '2027-02-26',
};

export function t1Result(): CalculationResult {
  return {
    inputs: {
      departureCity: 'Islamabad',
      arrivalDate: ARRIVAL,
      flexibilityDays: 0,
      nightsMakkah: 3,
      nightsMadinah: 2,
      order: 'makkah_first',
      travelers: { adults: 4, children: 0, infants: 0 },
      rooms: [{ occupancy: 'quad', persons: 4 }],
      hotels: { makkah: MAKKAH, madinah: MADINAH },
      visa: 'direct',
      flight: 'estimate',
      extras: [],
    },
    rateVersionSnapshot: [
      { packageId: PACK, version: 1, supplierId: SUPPLIER, issueDate: '2026-10-27' },
    ],
    fx: { rate: '75.00', effectiveAt: new Date('2026-11-01T00:00:00Z') },
    markupPercent: 0,
    lineItems: [
      {
        kind: 'hotel',
        city: 'makkah',
        hotelId: MAKKAH,
        hotelName: 'Qila Ajiyad',
        firstNight: ARRIVAL,
        lastNight: addDays(ARRIVAL, 2),
        nights: 3,
        occupancy: 'quad',
        persons: 4,
        rooms: 1,
        basis: 'per_person',
        unitMinorSAR: 5000,
        amountMinorSAR: 60_000,
        amountMinorPKR: 4_500_000,
        source,
        label: 'Qila Ajiyad, 3 nights × 4 persons × SAR 50',
      },
      {
        kind: 'hotel',
        city: 'madinah',
        hotelId: MADINAH,
        hotelName: 'Waqar Salmiya/Jood Marjan',
        firstNight: addDays(ARRIVAL, 3),
        lastNight: addDays(ARRIVAL, 4),
        nights: 2,
        occupancy: 'quad',
        persons: 4,
        rooms: 1,
        basis: 'per_person',
        unitMinorSAR: 5400,
        amountMinorSAR: 43_200,
        amountMinorPKR: 3_240_000,
        source,
        label: 'Waqar Salmiya/Jood Marjan, 2 nights × 4 persons × SAR 54',
      },
      {
        kind: 'visa',
        visa: 'direct',
        persons: 4,
        unitMinorSAR: 55_000,
        amountMinorSAR: 220_000,
        amountMinorPKR: 16_500_000,
        source,
        label: 'Umrah visa (direct flight), 4 persons × SAR 550',
      },
    ],
    missing: [{ kind: 'flight', code: 'flight_no_estimate', message: 'Flight: request a quote' }],
    assumptions: [{ code: 'rates_can_change', message: 'Rates can change without notice.' }],
    exclusions: [{ code: 'flights_missing', message: 'Flights (not priced in this estimate)' }],
    totals: {
      groupMinorSAR: 323_200,
      groupMinorPKR: 24_240_000,
      perPersonMinorSAR: 80_800,
      perPersonMinorPKR: 6_060_000,
      payingPersons: 4,
      isPartial: true,
      range: null,
    },
    calculatedAt: new Date(),
    expiresAt: new Date(Date.now() + 72 * 3_600_000),
    hash: 'a'.repeat(64),
    engineVersion: '1.0.0',
  };
}
