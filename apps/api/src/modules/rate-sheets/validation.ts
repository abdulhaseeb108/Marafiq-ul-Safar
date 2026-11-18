/**
 * Validation rules for a rate pack (docs/03 section 4). A pure function: the
 * service loads everything it needs and passes it in, so every rule can be
 * tested without a database.
 *
 * Blocking errors stop a pack being published. Warnings must be acknowledged
 * by a staff user before publishing.
 */
import {
  perPersonCeilMinor,
  type PackageValidation,
  type PerPersonMinor,
  type PricingMode,
  type RatePackageStatus,
  type ValidationIssue,
  type VisaRateView,
} from '@marafiq/shared';

export interface ValidationInput {
  pack: {
    id: string;
    nightFrom: string | null;
    nightTo: string | null;
    currency: string;
    issueDate: string | null;
    seasonLabel: string | null;
    supersedesId: string | null;
  };
  rates: {
    id: string;
    hotelId: string | null;
    /** Name to use in messages. */
    label: string;
    pricingMode: PricingMode;
    roomPriceMinor: number | null;
    perPersonMinor: PerPersonMinor;
    confidence: number;
    edited: boolean;
  }[];
  visa: VisaRateView | null;
  /** Every other pack of the same supplier. `rates` only on published ones. */
  others: {
    id: string;
    packName: string;
    status: RatePackageStatus;
    nightFrom: string | null;
    nightTo: string | null;
    issueDate: string | null;
    seasonLabel: string | null;
    rates: { hotelId: string | null; pricingMode: PricingMode; roomPriceMinor: number | null }[];
  }[];
  /** Hotels that already had a flat-room rate in a published pack. */
  knownFlatHotelIds: ReadonlySet<string>;
  /** "YYYY-MM-DD". */
  today: string;
}

const OCCUPANCIES = [
  ['quint', 5],
  ['quad', 4],
  ['triple', 3],
  ['double', 2],
] as const;

const ONE_SAR = 100;
const PRICE_CHANGE_PERCENT = 25;
const HOTEL_COUNT_TOLERANCE = 3;
const ISSUE_DATE_MAX_AGE_DAYS = 45;
const LOW_CONFIDENCE = 0.9;

const sar = (minor: number): string => String(minor / ONE_SAR);

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** ISO dates compare correctly as strings. Ranges are inclusive. */
function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

type Others = ValidationInput['others'];

/**
 * The pack to compare prices and hotel counts against: the one being replaced
 * if marked; otherwise the latest published pack of the same season that ends
 * before this one starts; otherwise the latest published pack that does.
 */
function referencePack(pack: ValidationInput['pack'], others: Others): Others[number] | undefined {
  const published = others.filter((o) => o.status === 'published');
  if (pack.supersedesId) {
    const replaced = published.find((o) => o.id === pack.supersedesId);
    if (replaced) return replaced;
  }
  if (!pack.nightFrom) return undefined;
  const earlier = published
    .filter((o) => o.nightTo !== null && o.nightTo < (pack.nightFrom as string))
    .sort((a, b) => (b.nightTo as string).localeCompare(a.nightTo as string));
  return earlier.find((o) => o.seasonLabel === pack.seasonLabel) ?? earlier[0];
}

export function validatePackage(input: ValidationInput): PackageValidation {
  const { pack, rates, visa, others } = input;
  const blocking: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // --- header -------------------------------------------------------------
  if (!pack.nightFrom || !pack.nightTo) {
    blocking.push({
      code: 'missing_dates',
      message: 'The night dates are missing.',
      path: 'header',
    });
  } else if (pack.nightTo < pack.nightFrom) {
    blocking.push({
      code: 'dates_reversed',
      message: 'The last night is before the first night.',
      path: 'header',
    });
  } else {
    for (const o of others) {
      if (o.status !== 'published' || o.id === pack.supersedesId) continue;
      if (!o.nightFrom || !o.nightTo) continue;
      if (overlaps(pack.nightFrom, pack.nightTo, o.nightFrom, o.nightTo)) {
        blocking.push({
          code: 'overlaps_published',
          message: `These nights overlap the published pack "${o.packName}" (${o.nightFrom} to ${o.nightTo}). Mark this pack as replacing it, or correct the dates.`,
          path: 'header',
        });
      }
    }
  }

  if (pack.currency !== 'SAR') {
    blocking.push({
      code: 'currency_not_sar',
      message: `The sheet is in ${pack.currency}. Only SAR is supported.`,
      path: 'header',
    });
  }

  if (!pack.issueDate) {
    warnings.push({
      code: 'issue_date_missing',
      message: 'The sheet has no issue date. Check it is the current one.',
      path: 'header',
    });
  } else if (daysBetween(pack.issueDate, input.today) > ISSUE_DATE_MAX_AGE_DAYS) {
    warnings.push({
      code: 'issue_date_old',
      message: `The sheet was issued on ${pack.issueDate}, more than ${ISSUE_DATE_MAX_AGE_DAYS} days ago. Check for a newer one.`,
      path: 'header',
    });
  }

  if (pack.nightFrom && pack.nightTo) {
    for (const o of others) {
      if (o.status === 'rejected' || o.status === 'superseded' || o.id === pack.supersedesId)
        continue;
      if (
        o.nightFrom === pack.nightFrom &&
        o.nightTo === pack.nightTo &&
        o.issueDate !== pack.issueDate
      ) {
        warnings.push({
          code: 'same_dates_other_issue_date',
          message: `Another pack, "${o.packName}", covers the same nights but was issued on ${o.issueDate ?? 'an unknown date'}. Decide which sheet is current before publishing.`,
          path: 'header',
        });
      }
    }
  }

  // --- visa ---------------------------------------------------------------
  const visaAmounts = visa
    ? [visa.directPerPersonMinor, ...Object.values(visa.indirectByGroupSizeMinor)]
    : [null];
  if (visaAmounts.some((amount) => amount === null)) {
    blocking.push({
      code: 'visa_missing',
      message: 'The direct visa rate and all four group-size visa rates are required.',
      path: 'visa',
    });
  }
  if (visa) {
    if ([...visaAmounts, visa.infantMinor].some((amount) => amount !== null && amount <= 0)) {
      blocking.push({
        code: 'non_positive_price',
        message: 'A visa rate is zero or negative.',
        path: 'visa',
      });
    }
    if (visa.infantMinor === null) {
      warnings.push({
        code: 'infant_visa_missing',
        message: 'There is no infant visa rate. Trips with infants will need a manual quote.',
        path: 'visa',
      });
    }
  }

  // --- hotel rows ---------------------------------------------------------
  const reference = referencePack(pack, others);
  const referenceRoom = new Map<string, number>();
  for (const r of reference?.rates ?? []) {
    if (r.hotelId && r.roomPriceMinor !== null) referenceRoom.set(r.hotelId, r.roomPriceMinor);
  }

  const seenHotels = new Set<string>();
  for (const rate of rates) {
    const path = `rate:${rate.id}`;

    if (!rate.hotelId) {
      blocking.push({
        code: 'hotel_unconfirmed',
        message: `"${rate.label}" is not a known hotel. Create it or match it to an existing hotel.`,
        path,
      });
    } else if (seenHotels.has(rate.hotelId)) {
      blocking.push({
        code: 'duplicate_hotel',
        message: `"${rate.label}" appears on more than one row. Remove the extra row.`,
        path,
      });
    } else {
      seenHotels.add(rate.hotelId);
    }

    if (rate.confidence < LOW_CONFIDENCE && !rate.edited) {
      warnings.push({
        code: 'low_confidence',
        message: `"${rate.label}" was hard to read. Check it against the original.`,
        path,
      });
    }

    if (rate.pricingMode === 'on_request') continue;

    const perPerson = OCCUPANCIES.map(([key]) => rate.perPersonMinor[key]);
    if ([rate.roomPriceMinor, ...perPerson].some((amount) => amount !== null && amount <= 0)) {
      blocking.push({
        code: 'non_positive_price',
        message: `"${rate.label}" has a price that is zero or negative.`,
        path,
      });
    }

    if (rate.roomPriceMinor === null) {
      blocking.push(
        rate.pricingMode === 'derived_per_person'
          ? {
              code: 'derived_without_room',
              message: `"${rate.label}" has no room price.`,
              path,
            }
          : {
              code: 'flat_without_price',
              message: `"${rate.label}" is priced per room but has no price.`,
              path,
            },
      );
      continue;
    }

    if (rate.pricingMode === 'derived_per_person') {
      for (const [key, occupancy] of OCCUPANCIES) {
        const printed = rate.perPersonMinor[key];
        if (printed === null || printed <= 0 || rate.roomPriceMinor <= 0) continue;
        const expected = perPersonCeilMinor(rate.roomPriceMinor, occupancy);
        if (Math.abs(printed - expected) > ONE_SAR) {
          warnings.push({
            code: 'derived_mismatch',
            message: `"${rate.label}" ${key}: printed ${sar(printed)}, but room ${sar(rate.roomPriceMinor)} ÷ ${occupancy} gives ${sar(expected)}.`,
            path,
          });
        }
      }
    } else if (rate.hotelId && !input.knownFlatHotelIds.has(rate.hotelId)) {
      warnings.push({
        code: 'flat_first_seen',
        message: `"${rate.label}" is priced per room (${sar(rate.roomPriceMinor)} a night whatever the occupancy) for the first time. Confirm that is what the sheet means.`,
        path,
      });
    }

    const before = rate.hotelId ? referenceRoom.get(rate.hotelId) : undefined;
    if (before !== undefined && before > 0 && rate.roomPriceMinor > 0) {
      const change = Math.abs(rate.roomPriceMinor - before);
      if (change * 100 > before * PRICE_CHANGE_PERCENT) {
        warnings.push({
          code: 'price_change',
          message: `"${rate.label}" room price is ${sar(rate.roomPriceMinor)}; it was ${sar(before)} in "${reference?.packName ?? 'the previous pack'}" (more than ${PRICE_CHANGE_PERCENT}% different).`,
          path,
        });
      }
    }
  }

  if (reference && Math.abs(rates.length - reference.rates.length) > HOTEL_COUNT_TOLERANCE) {
    warnings.push({
      code: 'hotel_count_changed',
      message: `This pack has ${rates.length} hotels; "${reference.packName}" had ${reference.rates.length}.`,
      path: 'header',
    });
  }

  return { blocking, warnings };
}
