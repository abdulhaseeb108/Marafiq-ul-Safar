/** Every rule in docs/03 section 4, against the pure validator. */
import { describe, expect, it } from 'vitest';
import { validatePackage, type ValidationInput } from './validation.js';

const SAR = (n: number) => n * 100;
const H1 = '64b7f0c2a1b2c3d4e5f60001';
const H2 = '64b7f0c2a1b2c3d4e5f60002';

type Rate = ValidationInput['rates'][number];
type Other = ValidationInput['others'][number];

const rate = (overrides: Partial<Rate> = {}): Rate => ({
  id: 'r1',
  hotelId: H1,
  label: 'Qila Ajiyad',
  pricingMode: 'derived_per_person',
  roomPriceMinor: SAR(200),
  perPersonMinor: { quint: SAR(40), quad: SAR(50), triple: SAR(67), double: SAR(100) },
  confidence: 0.99,
  edited: false,
  ...overrides,
});

const other = (overrides: Partial<Other> = {}): Other => ({
  id: 'p-old',
  packName: 'Older Pack',
  status: 'published',
  nightFrom: '2027-01-01',
  nightTo: '2027-01-31',
  issueDate: '2026-10-27',
  seasonLabel: 'Ramadan',
  rates: [],
  ...overrides,
});

const input = (overrides: Partial<ValidationInput> = {}): ValidationInput => ({
  pack: {
    id: 'p1',
    nightFrom: '2027-02-06',
    nightTo: '2027-02-26',
    currency: 'SAR',
    issueDate: '2026-10-27',
    seasonLabel: 'Ramadan',
    supersedesId: null,
  },
  rates: [rate()],
  visa: {
    directPerPersonMinor: SAR(550),
    indirectByGroupSizeMinor: { '1': SAR(700), '2': SAR(675), '3': SAR(650), '4': SAR(625) },
    infantMinor: SAR(460),
    appliesNote: null,
  },
  others: [],
  knownFlatHotelIds: new Set(),
  today: '2026-11-12',
  ...overrides,
});

const codes = (list: { code: string }[]) => list.map((issue) => issue.code);

describe('a clean pack', () => {
  it('has no blocking errors and no warnings', () => {
    expect(validatePackage(input())).toEqual({ blocking: [], warnings: [] });
  });
});

describe('blocking errors', () => {
  it('missing or reversed night dates', () => {
    const base = input();
    const missing = validatePackage({ ...base, pack: { ...base.pack, nightTo: null } });
    expect(codes(missing.blocking)).toContain('missing_dates');
    const reversed = validatePackage({
      ...base,
      pack: { ...base.pack, nightFrom: '2027-02-26', nightTo: '2027-02-06' },
    });
    expect(codes(reversed.blocking)).toContain('dates_reversed');
  });

  it('a currency other than SAR', () => {
    const base = input();
    const result = validatePackage({ ...base, pack: { ...base.pack, currency: 'USD' } });
    expect(codes(result.blocking)).toContain('currency_not_sar');
  });

  it('a per-person row with no room value', () => {
    const result = validatePackage(input({ rates: [rate({ roomPriceMinor: null })] }));
    expect(result.blocking).toContainEqual(
      expect.objectContaining({ code: 'derived_without_room', path: 'rate:r1' }),
    );
  });

  it('a flat-room row with no price', () => {
    const result = validatePackage(
      input({ rates: [rate({ pricingMode: 'flat_per_room', roomPriceMinor: null })] }),
    );
    expect(codes(result.blocking)).toContain('flat_without_price');
  });

  it('a zero price anywhere, but not on an on-request row', () => {
    const zeroRoom = validatePackage(input({ rates: [rate({ roomPriceMinor: 0 })] }));
    expect(codes(zeroRoom.blocking)).toContain('non_positive_price');

    const zeroQuad = validatePackage(
      input({
        rates: [
          rate({ perPersonMinor: { quint: SAR(40), quad: 0, triple: SAR(67), double: SAR(100) } }),
        ],
      }),
    );
    expect(codes(zeroQuad.blocking)).toContain('non_positive_price');

    const onRequest = validatePackage(
      input({
        rates: [
          rate({
            pricingMode: 'on_request',
            roomPriceMinor: null,
            perPersonMinor: { quint: null, quad: null, triple: null, double: null },
          }),
        ],
      }),
    );
    expect(onRequest.blocking).toEqual([]);
  });

  it('dates overlapping another published pack that is not marked as replaced', () => {
    const overlapping = other({ id: 'p-live', nightFrom: '2027-02-20', nightTo: '2027-03-05' });
    const result = validatePackage(input({ others: [overlapping] }));
    expect(codes(result.blocking)).toContain('overlaps_published');

    const base = input({ others: [overlapping] });
    const marked = validatePackage({ ...base, pack: { ...base.pack, supersedesId: 'p-live' } });
    expect(codes(marked.blocking)).not.toContain('overlaps_published');
  });

  it('does not treat touching dates or unpublished packs as an overlap', () => {
    const before = other({ nightFrom: '2027-01-20', nightTo: '2027-02-05' });
    const draft = other({
      id: 'p-draft',
      status: 'needs_review',
      nightFrom: '2027-02-06',
      nightTo: '2027-02-26',
    });
    const superseded = other({
      id: 'p-sup',
      status: 'superseded',
      nightFrom: '2027-02-06',
      nightTo: '2027-02-26',
    });
    const result = validatePackage(input({ others: [before, draft, superseded] }));
    expect(codes(result.blocking)).not.toContain('overlaps_published');
  });

  it('a hotel name nobody has confirmed', () => {
    const result = validatePackage(
      input({ rates: [rate({ hotelId: null, label: 'Mystery Inn' })] }),
    );
    expect(result.blocking).toContainEqual(
      expect.objectContaining({ code: 'hotel_unconfirmed', path: 'rate:r1' }),
    );
  });

  it('the same hotel on two rows', () => {
    const result = validatePackage(input({ rates: [rate(), rate({ id: 'r2' })] }));
    expect(codes(result.blocking)).toContain('duplicate_hotel');
  });

  it('a missing direct or group-size visa rate', () => {
    const base = input();
    const noDirect = validatePackage({
      ...base,
      visa: { ...base.visa!, directPerPersonMinor: null },
    });
    expect(codes(noDirect.blocking)).toContain('visa_missing');
    const noGroup = validatePackage({
      ...base,
      visa: {
        ...base.visa!,
        indirectByGroupSizeMinor: { '1': SAR(700), '2': null, '3': SAR(650), '4': SAR(625) },
      },
    });
    expect(codes(noGroup.blocking)).toContain('visa_missing');
    expect(codes(validatePackage({ ...base, visa: null }).blocking)).toContain('visa_missing');
  });
});

describe('warnings', () => {
  it('a printed per-person value more than 1 SAR away from ceil(room / occupancy)', () => {
    const off = rate({
      perPersonMinor: { quint: SAR(40), quad: SAR(50), triple: SAR(70), double: SAR(100) },
    });
    const result = validatePackage(input({ rates: [off] }));
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'derived_mismatch', path: 'rate:r1' }),
    );
    expect(result.blocking).toEqual([]);
  });

  it('accepts the real rounding: room 95 gives 19 / 24 / 32 / 48 (T4)', () => {
    const shawal = rate({
      roomPriceMinor: SAR(95),
      perPersonMinor: { quint: SAR(19), quad: SAR(24), triple: SAR(32), double: SAR(48) },
    });
    expect(codes(validatePackage(input({ rates: [shawal] })).warnings)).not.toContain(
      'derived_mismatch',
    );
  });

  it('does not run the derived check on a flat-room row that keeps printed figures', () => {
    const akabir = rate({
      pricingMode: 'flat_per_room',
      roomPriceMinor: SAR(600),
      perPersonMinor: { quint: null, quad: SAR(150), triple: SAR(200), double: SAR(300) },
    });
    const result = validatePackage(input({ rates: [akabir], knownFlatHotelIds: new Set([H1]) }));
    expect(result).toEqual({ blocking: [], warnings: [] });
  });

  it('a price change above 25% against the previous pack of the same season', () => {
    const previous = other({
      rates: [{ hotelId: H1, pricingMode: 'derived_per_person', roomPriceMinor: SAR(150) }],
    });
    const result = validatePackage(input({ others: [previous] })); // 150 -> 200 is +33%
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'price_change', path: 'rate:r1' }),
    );

    const small = other({
      rates: [{ hotelId: H1, pricingMode: 'derived_per_person', roomPriceMinor: SAR(160) }],
    });
    expect(codes(validatePackage(input({ others: [small] })).warnings)).not.toContain(
      'price_change',
    ); // exactly +25%
  });

  it('compares against the pack being replaced when one is marked', () => {
    const replaced = other({
      id: 'p-live',
      nightFrom: '2027-02-06',
      nightTo: '2027-02-26',
      rates: [{ hotelId: H1, pricingMode: 'derived_per_person', roomPriceMinor: SAR(100) }],
    });
    const base = input({ others: [replaced] });
    const result = validatePackage({ ...base, pack: { ...base.pack, supersedesId: 'p-live' } });
    expect(codes(result.warnings)).toContain('price_change');
  });

  it('a hotel count more than 3 away from the previous pack', () => {
    const previous = other({
      rates: [1, 2, 3, 4, 5].map((n) => ({
        hotelId: `64b7f0c2a1b2c3d4e5f6010${n}`,
        pricingMode: 'on_request' as const,
        roomPriceMinor: null,
      })),
    });
    expect(codes(validatePackage(input({ others: [previous] })).warnings)).toContain(
      'hotel_count_changed',
    );
  });

  it('an issue date that is missing or older than 45 days', () => {
    const base = input();
    const missing = validatePackage({ ...base, pack: { ...base.pack, issueDate: null } });
    expect(codes(missing.warnings)).toContain('issue_date_missing');
    const old = validatePackage({ ...base, today: '2026-12-12' }); // 46 days after 27 Oct
    expect(codes(old.warnings)).toContain('issue_date_old');
    const fine = validatePackage({ ...base, today: '2026-12-11' }); // exactly 45
    expect(codes(fine.warnings)).not.toContain('issue_date_old');
  });

  it('a flat-room row seen for the first time, once only', () => {
    const flat = rate({ pricingMode: 'flat_per_room', roomPriceMinor: SAR(200) });
    expect(codes(validatePackage(input({ rates: [flat] })).warnings)).toContain('flat_first_seen');
    const known = validatePackage(input({ rates: [flat], knownFlatHotelIds: new Set([H1]) }));
    expect(codes(known.warnings)).not.toContain('flat_first_seen');
  });

  it('the same pack dates under a different issue date (T10)', () => {
    const earlier = other({
      id: 'p-17oct',
      status: 'needs_review',
      nightFrom: '2027-02-06',
      nightTo: '2027-02-26',
      issueDate: '2026-10-17',
    });
    const result = validatePackage(input({ others: [earlier] }));
    expect(codes(result.warnings)).toContain('same_dates_other_issue_date');

    const sameIssue = validatePackage(input({ others: [{ ...earlier, issueDate: '2026-10-27' }] }));
    expect(codes(sameIssue.warnings)).not.toContain('same_dates_other_issue_date');
    const rejected = validatePackage(input({ others: [{ ...earlier, status: 'rejected' }] }));
    expect(codes(rejected.warnings)).not.toContain('same_dates_other_issue_date');
  });

  it('a row read with confidence below 0.9, until staff edit it', () => {
    const unsure = validatePackage(input({ rates: [rate({ confidence: 0.6 })] }));
    expect(unsure.warnings).toContainEqual(
      expect.objectContaining({ code: 'low_confidence', path: 'rate:r1' }),
    );
    const checked = validatePackage(input({ rates: [rate({ confidence: 0.6, edited: true })] }));
    expect(codes(checked.warnings)).not.toContain('low_confidence');
  });

  it('a missing infant visa rate', () => {
    const base = input();
    const result = validatePackage({ ...base, visa: { ...base.visa!, infantMinor: null } });
    expect(codes(result.warnings)).toContain('infant_visa_missing');
    expect(result.blocking).toEqual([]);
  });

  it('two different hotels in one pack are not duplicates', () => {
    const result = validatePackage(input({ rates: [rate(), rate({ id: 'r2', hotelId: H2 })] }));
    expect(result.blocking).toEqual([]);
  });
});
