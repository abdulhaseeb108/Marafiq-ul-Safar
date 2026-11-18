/**
 * docs/03 section 7, T1-T8, against the real WMT sheet (docs/seed), with
 * FX 75.00 PKR per SAR and markup 0. The engine is pure, so no database.
 */
import {
  CalculateInputSchema,
  CalculationResultSchema,
  convertSarToPkrWholeRupeesMinor,
  parseFxRate,
  perPersonCeilMinor,
  sumMinor,
  type CalculateInputBody,
  type CalculationResult,
  type HotelLine,
  type VisaLine,
} from '@marafiq/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NOW, fixtureContext, fixturePackages, hotelId } from '../../test/pricing-fixture.js';
import { buildNights, calculate, type PricingContext } from './engine.js';

const QILA = hotelId('Qila Ajiyad');
const SALMIYA = hotelId('Waqar Salmiya/Jood Marjan');
const VOCO = hotelId('Voco');
const AKABIR = hotelId('Akabir Hijrah/Areej Wafa/Mather Elite');

const SAR = (major: number) => major * 100;
const PKR = (major: number) => major * 100;

function input(overrides: Partial<CalculateInputBody> = {}) {
  return CalculateInputSchema.parse({
    departureCity: 'Islamabad',
    arrivalDate: '2027-02-08',
    nightsMakkah: 3,
    nightsMadinah: 0,
    order: 'makkah_first',
    travelers: { adults: 2 },
    rooms: [{ occupancy: 'double', persons: 2 }],
    hotels: { makkah: QILA },
    visa: 'direct',
    flight: 'estimate',
    ...overrides,
  });
}

function run(body: Partial<CalculateInputBody>, ctx: PricingContext = fixtureContext()) {
  const result = calculate(input(body), ctx);
  // Every result must be a valid stored calculation.
  CalculationResultSchema.parse(result);
  return result;
}

const hotels = (r: CalculationResult) =>
  r.lineItems.filter((l): l is HotelLine => l.kind === 'hotel');
const visas = (r: CalculationResult) => r.lineItems.filter((l): l is VisaLine => l.kind === 'visa');

const T1: Partial<CalculateInputBody> = {
  arrivalDate: '2027-02-08',
  nightsMakkah: 3,
  nightsMadinah: 2,
  order: 'makkah_first',
  travelers: { adults: 4 },
  rooms: [{ occupancy: 'quad', persons: 4 }],
  hotels: { makkah: QILA, madinah: SALMIYA },
  visa: 'direct',
  flight: 'estimate',
};

describe('night list', () => {
  it('Makkah first starts in Makkah on the arrival date', () => {
    const nights = buildNights(
      input({ nightsMakkah: 2, nightsMadinah: 1, hotels: { makkah: QILA, madinah: SALMIYA } }),
    );
    expect(nights).toEqual([
      { date: '2027-02-08', city: 'makkah' },
      { date: '2027-02-09', city: 'makkah' },
      { date: '2027-02-10', city: 'madinah' },
    ]);
  });

  it('Madinah first reverses the cities, across a month end', () => {
    const nights = buildNights(
      input({
        arrivalDate: '2027-02-27',
        nightsMakkah: 1,
        nightsMadinah: 2,
        order: 'madinah_first',
        hotels: { makkah: QILA, madinah: SALMIYA },
      }),
    );
    expect(nights.map((n) => `${n.date} ${n.city}`)).toEqual([
      '2027-02-27 madinah',
      '2027-02-28 madinah',
      '2027-03-01 makkah',
    ]);
  });
});

describe('T1: 4 adults, quad, 3 nights Qila Ajiyad + 2 nights Waqar Salmiya, direct visa', () => {
  const result = run(T1);

  it('prices each part as the sheet prints it', () => {
    expect(hotels(result).map((l) => [l.hotelName, l.amountMinorSAR])).toEqual([
      ['Qila Ajiyad', SAR(600)],
      ['Waqar Salmiya/Jood Marjan', SAR(432)],
    ]);
    expect(hotels(result)[0]?.label).toBe('Qila Ajiyad, 3 nights × 4 persons × SAR 50');
    expect(visas(result).map((l) => l.amountMinorSAR)).toEqual([SAR(2200)]);
  });

  it('totals SAR 3,232, SAR 808 per person, PKR 242,400', () => {
    expect(result.totals).toMatchObject({
      groupMinorSAR: SAR(3232),
      perPersonMinorSAR: SAR(808),
      groupMinorPKR: PKR(242_400),
      perPersonMinorPKR: PKR(60_600),
      payingPersons: 4,
    });
  });

  it('is partial: there is no flight estimate for Islamabad', () => {
    expect(result.totals.isPartial).toBe(true);
    expect(result.totals.range).toBeNull();
    expect(result.missing.map((m) => m.code)).toEqual(['flight_no_estimate']);
  });

  it('every price carries supplier, pack and issue date', () => {
    for (const line of [...hotels(result), ...visas(result)]) {
      expect(line.source).toMatchObject({
        supplierName: 'Waqar-e-Madina Group (WMT)',
        packName: 'Ramadan Pack 01',
        issueDate: '2026-10-27',
      });
    }
    expect(result.assumptions.map((a) => a.code)).toContain('rates_can_change');
    expect(result.rateVersionSnapshot).toHaveLength(1);
  });

  it('expires 72 hours after calculating, before the pack ends', () => {
    expect(result.expiresAt.toISOString()).toBe('2026-11-05T09:00:00.000Z');
  });
});

describe('T2: 2 adults, double, 4 nights Qila Ajiyad from 25 Feb 2027, across Pack 01 -> 02', () => {
  const result = run({
    arrivalDate: '2027-02-25',
    nightsMakkah: 4,
    travelers: { adults: 2 },
    rooms: [{ occupancy: 'double', persons: 2 }],
  });

  it('gives SAR 1,100 hotel in two lines with different pack names', () => {
    const lines = hotels(result);
    expect(
      lines.map((l) => [l.firstNight, l.lastNight, l.unitMinorSAR, l.source.packName]),
    ).toEqual([
      ['2027-02-25', '2027-02-26', SAR(100), 'Ramadan Pack 01'],
      ['2027-02-27', '2027-02-28', SAR(175), 'Ramadan Pack 02'],
    ]);
    expect(sumMinor(lines.map((l) => l.amountMinorSAR))).toBe(SAR(1100));
    expect(result.rateVersionSnapshot).toHaveLength(2);
  });

  it('takes the visa from the pack of the first night', () => {
    expect(visas(result)[0]?.source.packName).toBe('Ramadan Pack 01');
  });
});

describe('T3: arrival 10 Apr 2027, after the Shawal pack', () => {
  const result = run({ arrivalDate: '2027-04-10', nightsMakkah: 3 });

  it('sends the hotel to "Request a quote" with no hotel total', () => {
    expect(hotels(result)).toEqual([]);
    expect(result.missing).toContainEqual(
      expect.objectContaining({
        kind: 'hotel',
        code: 'hotel_no_rate',
        message: 'No published rate for Qila Ajiyad on 2027-04-10 to 2027-04-12 — Request a quote',
      }),
    );
    expect(result.totals.isPartial).toBe(true);
  });

  it('does not invent a visa price either', () => {
    expect(visas(result)).toEqual([]);
    expect(result.missing.map((m) => m.code)).toContain('visa_no_rate');
    expect(result.totals.groupMinorSAR).toBe(0);
    expect(result.rateVersionSnapshot).toEqual([]);
  });

  it('prices the nights still inside the pack and lists only the rest as missing', () => {
    const partly = run({ arrivalDate: '2027-04-05', nightsMakkah: 3 });
    expect(hotels(partly).map((l) => [l.firstNight, l.lastNight])).toEqual([
      ['2027-04-05', '2027-04-06'],
    ]);
    expect(partly.missing.find((m) => m.kind === 'hotel')?.params).toMatchObject({
      from: '2027-04-07',
      to: '2027-04-07',
    });
  });
});

describe('T4: 2 adults, double, 3 nights Qila Ajiyad from 15 Mar 2027 (Shawal)', () => {
  it('is SAR 288, and SAR 48 is the room price 95 split by two, rounded up', () => {
    const result = run({ arrivalDate: '2027-03-15', nightsMakkah: 3 });
    expect(hotels(result)[0]).toMatchObject({ unitMinorSAR: SAR(48), amountMinorSAR: SAR(288) });
    expect(perPersonCeilMinor(SAR(95), 2)).toBe(SAR(48));
  });
});

describe('T5: Voco is "on booking"', () => {
  it('is missing, makes the total partial, and invents no number', () => {
    const result = run({ hotels: { makkah: VOCO }, flight: 'self' });
    expect(hotels(result)).toEqual([]);
    expect(result.missing).toEqual([
      expect.objectContaining({ kind: 'hotel', code: 'hotel_on_request' }),
    ]);
    expect(result.totals.isPartial).toBe(true);
    // The visa is still priced.
    expect(result.totals.groupMinorSAR).toBe(SAR(1100));
  });
});

describe('T6: 2 adults + 1 infant, indirect visa', () => {
  const result = run({
    travelers: { adults: 2, infants: 1 },
    visa: 'indirect',
  });

  it('visa is 675 x 2 + 460 = SAR 1,810', () => {
    expect(visas(result).map((l) => [l.visa, l.persons, l.amountMinorSAR])).toEqual([
      ['indirect', 2, SAR(1350)],
      ['infant', 1, SAR(460)],
    ]);
    expect(sumMinor(visas(result).map((l) => l.amountMinorSAR))).toBe(SAR(1810));
  });

  it('charges the infant nothing for the hotel, with an assumption note', () => {
    expect(hotels(result)[0]).toMatchObject({ persons: 2, amountMinorSAR: SAR(600) });
    expect(result.assumptions.map((a) => a.code)).toContain('infant_no_hotel_charge');
  });

  it('uses the 4-pax rate for 5 or more travelers, with a visible note', () => {
    const big = run({
      travelers: { adults: 6 },
      rooms: [
        { occupancy: 'triple', persons: 3 },
        { occupancy: 'triple', persons: 3 },
      ],
      visa: 'indirect',
    });
    expect(visas(big)[0]).toMatchObject({ persons: 6, unitMinorSAR: SAR(625) });
    expect(big.assumptions.map((a) => a.code)).toContain('visa_group_5_plus');
  });
});

describe('T7: a new pack version does not change an earlier result', () => {
  it('the earlier result is kept as it was; a fresh one uses the new version', () => {
    const before = run(T1);
    const kept = structuredClone(before);

    const packages = fixturePackages().map((pack) =>
      pack.packName === 'Ramadan Pack 01'
        ? {
            ...pack,
            id: 'c00000000000000000000099',
            version: 2,
            rates: pack.rates.map((r) =>
              r.hotelId === QILA
                ? { ...r, perPersonMinor: { ...r.perPersonMinor, quad: SAR(60) } }
                : r,
            ),
          }
        : pack,
    );
    const after = run(T1, fixtureContext({ packages }));

    expect(before).toEqual(kept);
    expect(before.totals.groupMinorSAR).toBe(SAR(3232));
    expect(after.totals.groupMinorSAR).toBe(SAR(3232 + 120));
    expect(after.rateVersionSnapshot[0]).toMatchObject({ version: 2 });
    expect(after.hash).not.toBe(before.hash);
  });
});

describe('T8: money rounding', () => {
  it('derived per-person rates round up: room 200 / 3 = 67', () => {
    expect(perPersonCeilMinor(SAR(200), 3)).toBe(SAR(67));
  });

  it('PKR rounds half up per line, and the total is the sum of rounded lines', () => {
    // 66.67 x 74.99 = 4,999.58... -> 5,000; 0.02 x 75 = 1.5 -> 2.
    const rate = parseFxRate('74.99');
    expect(convertSarToPkrWholeRupeesMinor(6667, rate)).toBe(PKR(5000));
    expect(convertSarToPkrWholeRupeesMinor(2, parseFxRate('75'))).toBe(PKR(2));

    const result = run(T1, fixtureContext({ fx: { rate: '74.99', effectiveAt: NOW } }));
    const priced = [...hotels(result), ...visas(result)];
    for (const line of priced) {
      expect(line.amountMinorPKR % 100).toBe(0);
    }
    expect(result.totals.groupMinorPKR).toBe(sumMinor(priced.map((l) => l.amountMinorPKR)));
  });

  it('a per-person total that does not divide evenly rounds up to a whole unit', () => {
    // 3 adults, triple Qila Ajiyad (67), 1 night + visa 550: 3 x 617 = 1,851 / 3 = 617.
    const three = run({
      nightsMakkah: 1,
      travelers: { adults: 3 },
      rooms: [{ occupancy: 'triple', persons: 3 }],
      flight: 'self',
    });
    expect(three.totals.perPersonMinorSAR).toBe(SAR(617));
    expect(perPersonCeilMinor(SAR(1000), 3)).toBe(SAR(334));
  });
});

describe('rooms and pricing modes', () => {
  it('a room-basis row (Akabir Hijrah) is priced per room from the ROOM value', () => {
    const result = run({
      hotels: { makkah: AKABIR },
      travelers: { adults: 4 },
      rooms: [{ occupancy: 'quad', persons: 4 }],
    });
    expect(hotels(result)[0]).toMatchObject({
      basis: 'per_room',
      unitMinorSAR: SAR(600),
      amountMinorSAR: SAR(1800),
      label: 'Akabir Hijrah/Areej Wafa/Mather Elite, 3 nights × SAR 600 per room',
    });
    expect(result.assumptions.map((a) => a.code)).toContain('room_basis');
  });

  it('a whole room uses the room price', () => {
    const result = run({ rooms: [{ occupancy: 'whole_room', persons: 2 }] });
    expect(hotels(result)[0]).toMatchObject({
      basis: 'per_room',
      unitMinorSAR: SAR(200),
      amountMinorSAR: SAR(600),
    });
  });

  it('identical rooms are one line with a room count', () => {
    const result = run({
      travelers: { adults: 4 },
      rooms: [
        { occupancy: 'double', persons: 2 },
        { occupancy: 'double', persons: 2 },
      ],
    });
    expect(hotels(result)).toHaveLength(1);
    expect(hotels(result)[0]).toMatchObject({ rooms: 2, amountMinorSAR: SAR(1200) });
    expect(hotels(result)[0]?.label).toBe('Qila Ajiyad, 3 nights × 2 persons × 2 rooms × SAR 100');
  });

  it('a sharing room with free beds is priced per bed taken, with a note', () => {
    const result = run({ travelers: { adults: 3 }, rooms: [{ occupancy: 'quad', persons: 3 }] });
    expect(hotels(result)[0]).toMatchObject({ unitMinorSAR: SAR(50), amountMinorSAR: SAR(450) });
    expect(result.assumptions.map((a) => a.code)).toContain('shared_room_beds');
  });

  it('children are priced as adults and named in the assumptions', () => {
    const result = run({ travelers: { adults: 1, children: 1 } });
    expect(result.totals.payingPersons).toBe(2);
    expect(visas(result)[0]).toMatchObject({ persons: 2 });
    expect(result.assumptions.map((a) => a.code)).toContain('child_as_adult');
  });
});

describe('cheapest and nearest', () => {
  it('cheapest picks the lowest-priced hotel that is priced for every night', () => {
    const result = run({ hotels: { makkah: 'cheapest' }, flight: 'self' });
    const chosen = hotels(result);
    expect(chosen).toHaveLength(1);
    expect(result.missing).toEqual([]);
    expect(result.assumptions.map((a) => a.code)).toContain('hotel_picked_cheapest');
    // No priced Makkah hotel on these nights is cheaper.
    const others = fixtureContext().hotels.filter((h) => h.city === 'makkah');
    for (const hotel of others) {
      const alt = run({ hotels: { makkah: hotel.id }, flight: 'self' });
      if (alt.missing.length === 0 && hotels(alt).length > 0) {
        expect(chosen[0]?.amountMinorSAR).toBeLessThanOrEqual(hotels(alt)[0]?.amountMinorSAR ?? 0);
      }
    }
  });

  it('nearest picks the shortest stated distance', () => {
    const result = run({ hotels: { makkah: 'nearest' }, flight: 'self' });
    const chosen = fixtureContext().hotels.find((h) => h.id === hotels(result)[0]?.hotelId);
    const priced = fixtureContext()
      .hotels.filter((h) => h.city === 'makkah' && h.distanceMeters !== null)
      .filter((h) => {
        const alt = run({ hotels: { makkah: h.id }, flight: 'self' });
        return alt.missing.length === 0;
      });
    expect(chosen?.distanceMeters).toBe(Math.min(...priced.map((h) => h.distanceMeters as number)));
  });

  it('with no priced hotel at all, asks for a quote', () => {
    const result = run({ arrivalDate: '2027-05-01', hotels: { makkah: 'cheapest' } });
    expect(result.missing.map((m) => m.code)).toContain('hotel_none_available');
  });
});

describe('flights and extras', () => {
  const estimate = {
    id: 'd00000000000000000000001',
    originCity: 'Islamabad',
    destination: 'JED' as const,
    lowMinor: PKR(150_000),
    highMinor: PKR(210_000),
    validTo: '2027-01-31',
    source: 'partner quote',
  };

  it('a valid estimate adds a range and makes the totals a range', () => {
    const result = run(T1, fixtureContext({ flightEstimates: [estimate] }));
    const flight = result.lineItems.find((l) => l.kind === 'flight');
    expect(flight).toMatchObject({
      lowMinorPKR: PKR(600_000),
      highMinorPKR: PKR(840_000),
      adults: 4,
    });
    expect(result.totals.range).toEqual({
      groupLowMinorPKR: PKR(842_400),
      groupHighMinorPKR: PKR(1_082_400),
      perPersonLowMinorPKR: PKR(210_600),
      perPersonHighMinorPKR: PKR(270_600),
    });
    expect(result.totals.groupMinorPKR).toBe(PKR(242_400));
    expect(result.totals.isPartial).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('city names match without case; expired or other-airport estimates do not count', () => {
    const lower = run(
      { ...T1, departureCity: 'islamabad' },
      fixtureContext({ flightEstimates: [estimate] }),
    );
    expect(lower.lineItems.some((l) => l.kind === 'flight')).toBe(true);
    const expired = run(
      T1,
      fixtureContext({ flightEstimates: [{ ...estimate, validTo: '2026-11-01' }] }),
    );
    expect(expired.missing.map((m) => m.code)).toEqual(['flight_no_estimate']);
    const madinahFirst = run(
      { ...T1, order: 'madinah_first' },
      fixtureContext({ flightEstimates: [estimate] }),
    );
    expect(madinahFirst.missing.map((m) => m.code)).toEqual(['flight_no_estimate']);
  });

  it('children and infants on a flight estimate are "Request a quote"', () => {
    const result = run(
      { travelers: { adults: 1, children: 1 } },
      fixtureContext({ flightEstimates: [estimate] }),
    );
    expect(result.missing.map((m) => m.code)).toEqual(['flight_children']);
  });

  it('"I will arrange flights" is not missing, and can give a complete total', () => {
    const result = run({ flight: 'self' });
    expect(result.missing).toEqual([]);
    expect(result.totals.isPartial).toBe(false);
    expect(result.exclusions.map((e) => e.code)).toContain('flights_self');
  });

  it('extras are always "Request a quote"', () => {
    const result = run({ flight: 'self', extras: ['ziyarah', 'transfers'] });
    expect(result.missing.map((m) => m.code)).toEqual(['extra_ziyarah', 'extra_transfers']);
    expect(result.totals.isPartial).toBe(true);
  });
});

describe('markup and expiry', () => {
  it('markup is added to each SAR line, rounded up to the halala, before FX', () => {
    const ctx = fixtureContext();
    const result = run(T1, { ...ctx, settings: { ...ctx.settings, markupPercent: 2.5 } });
    // 600 x 1.025 = 615; 432 x 1.025 = 442.80; 2,200 x 1.025 = 2,255.
    expect(
      result.lineItems
        .filter((l) => l.kind !== 'flight')
        .map((l) => 'amountMinorSAR' in l && l.amountMinorSAR),
    ).toEqual([61_500, 44_280, 225_500]);
    expect(result.assumptions.map((a) => a.code)).toContain('markup_applied');
  });

  it('expires at the end of the earliest pack used when that comes first', () => {
    const ctx = fixtureContext({ now: new Date('2027-02-25T12:00:00.000Z') });
    const result = run({ arrivalDate: '2027-02-25', nightsMakkah: 4 }, ctx);
    // Pack 01 ends on the night of 26 Feb, Saudi time.
    expect(result.expiresAt.toISOString()).toBe('2027-02-26T20:59:59.999Z');
  });
});

describe('properties', () => {
  const ctx = fixtureContext();
  const makkah = ctx.hotels.filter((h) => h.city === 'makkah').map((h) => h.id);
  const madinah = ctx.hotels.filter((h) => h.city === 'madinah').map((h) => h.id);

  const occupancy = fc.constantFrom(
    'double',
    'triple',
    'quad',
    'quint',
    'whole_room',
  ) as fc.Arbitrary<'double' | 'triple' | 'quad' | 'quint' | 'whole_room'>;
  const beds = { double: 2, triple: 3, quad: 4, quint: 5, whole_room: 5 } as const;

  const inputs = fc
    .record({
      day: fc.integer({ min: 0, max: 75 }),
      nightsMakkah: fc.integer({ min: 0, max: 8 }),
      nightsMadinah: fc.integer({ min: 0, max: 8 }),
      order: fc.constantFrom('makkah_first', 'madinah_first') as fc.Arbitrary<
        'makkah_first' | 'madinah_first'
      >,
      rooms: fc.array(
        occupancy.chain((o) =>
          fc.record({ occupancy: fc.constant(o), persons: fc.integer({ min: 1, max: beds[o] }) }),
        ),
        { minLength: 1, maxLength: 3 },
      ),
      infants: fc.integer({ min: 0, max: 2 }),
      makkahHotel: fc.constantFrom(...makkah, 'cheapest', 'nearest'),
      madinahHotel: fc.constantFrom(...madinah, 'cheapest', 'nearest'),
      visa: fc.constantFrom('direct', 'indirect') as fc.Arbitrary<'direct' | 'indirect'>,
      flight: fc.constantFrom('estimate', 'self') as fc.Arbitrary<'estimate' | 'self'>,
    })
    .filter((r) => r.nightsMakkah + r.nightsMadinah > 0)
    .map((r) => {
      const persons = r.rooms.reduce((sum, room) => sum + room.persons, 0);
      const arrival = new Date(Date.UTC(2027, 1, 1 + r.day)).toISOString().slice(0, 10);
      return CalculateInputSchema.parse({
        departureCity: 'Islamabad',
        arrivalDate: arrival,
        nightsMakkah: r.nightsMakkah,
        nightsMadinah: r.nightsMadinah,
        order: r.order,
        travelers: { adults: persons, infants: r.infants },
        rooms: r.rooms,
        hotels: {
          ...(r.nightsMakkah > 0 ? { makkah: r.makkahHotel } : {}),
          ...(r.nightsMadinah > 0 ? { madinah: r.madinahHotel } : {}),
        },
        visa: r.visa,
        flight: r.flight,
      });
    });

  it('totals are never negative and always equal the sum of the lines', () => {
    fc.assert(
      fc.property(inputs, (body) => {
        const result = calculate(body, ctx);
        CalculationResultSchema.parse(result);
        const priced = result.lineItems.filter((l) => l.kind !== 'flight') as (
          HotelLine | VisaLine
        )[];
        expect(result.totals.groupMinorSAR).toBeGreaterThanOrEqual(0);
        expect(result.totals.groupMinorPKR).toBeGreaterThanOrEqual(0);
        expect(result.totals.groupMinorSAR).toBe(sumMinor(priced.map((l) => l.amountMinorSAR)));
        expect(result.totals.groupMinorPKR).toBe(sumMinor(priced.map((l) => l.amountMinorPKR)));
        expect(result.totals.isPartial).toBe(
          result.missing.length > 0 || result.totals.range !== null,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('changing FX changes PKR amounts only', () => {
    fc.assert(
      fc.property(inputs, fc.integer({ min: 10_000, max: 2_000_000 }), (body, scaled) => {
        const rate = (scaled / 10_000).toFixed(4);
        const a = calculate(body, ctx);
        const b = calculate(body, { ...ctx, fx: { rate, effectiveAt: ctx.fx.effectiveAt } });
        const sarOnly = (r: CalculationResult) =>
          r.lineItems.map((l) => ('amountMinorSAR' in l ? [l.label, l.amountMinorSAR] : [l.label]));
        expect(sarOnly(b)).toEqual(sarOnly(a));
        expect(b.totals.groupMinorSAR).toBe(a.totals.groupMinorSAR);
        expect(b.missing).toEqual(a.missing);
      }),
      { numRuns: 150 },
    );
  });

  it('identical inputs and rate versions give an identical hash', () => {
    fc.assert(
      fc.property(inputs, (body) => {
        const a = calculate(body, ctx);
        const b = calculate(structuredClone(body), {
          ...ctx,
          now: new Date(ctx.now.getTime() + 60_000),
        });
        expect(b.hash).toBe(a.hash);
        expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 150 },
    );
  });
});
