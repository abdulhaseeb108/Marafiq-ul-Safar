/**
 * The pricing engine (docs/03 section 6). A pure function: everything it
 * needs arrives in `ctx`, so the same inputs and rate versions always give the
 * same result. No database, clock or random calls in here.
 *
 * Money is integer minor units and goes through @marafiq/shared money helpers.
 */
import { createHash } from 'node:crypto';
import {
  OCCUPANCY_BEDS,
  applyMarkupCeil,
  convertSarToPkrWholeRupeesMinor,
  markupPercentToBps,
  parseFxRate,
  perPersonCeilMinor,
  sumMinor,
  type CalculateInput,
  type CalculationResult,
  type FlightLine,
  type HotelLine,
  type LineItem,
  type MissingItem,
  type Note,
  type PriceSource,
  type RoomOccupancy,
  type VisaLine,
} from '@marafiq/shared';

export const ENGINE_VERSION = '1.0.0';

type City = 'makkah' | 'madinah';

export interface CtxHotel {
  id: string;
  city: City;
  name: string;
  distanceMeters: number | null;
}

export interface CtxHotelRate {
  hotelId: string;
  pricingMode: 'derived_per_person' | 'flat_per_room' | 'on_request';
  roomPriceMinor: number | null;
  perPersonMinor: {
    quint: number | null;
    quad: number | null;
    triple: number | null;
    double: number | null;
  };
}

export interface CtxVisa {
  directPerPersonMinor: number | null;
  indirectByGroupSize: Record<'1' | '2' | '3' | '4', number | null>;
  infantMinor: number | null;
}

/** A published pack with its rows. */
export interface CtxPackage {
  id: string;
  version: number;
  supplierId: string;
  supplierName: string;
  packName: string;
  nightFrom: string;
  nightTo: string;
  issueDate: string | null;
  /** ISO timestamp; breaks ties between suppliers covering the same night. */
  publishedAt: string;
  rates: CtxHotelRate[];
  visa: CtxVisa | null;
}

export interface CtxFlightEstimate {
  id: string;
  originCity: string;
  destination: 'JED' | 'MED';
  lowMinor: number;
  highMinor: number;
  validTo: string;
  source: string;
}

export interface PricingContext {
  now: Date;
  settings: {
    markupPercent: number;
    estimateExpiryHours: number;
    childAsAdult: boolean;
    infantHotelCharge: 'none';
  };
  fx: { rate: string; effectiveAt: Date };
  hotels: CtxHotel[];
  packages: CtxPackage[];
  flightEstimates: CtxFlightEstimate[];
}

interface Night {
  date: string;
  city: City;
}

interface RoomGroup {
  occupancy: RoomOccupancy;
  persons: number;
  count: number;
}

/** Hotel nights priced for one hotel: lines, or the reason it cannot be priced. */
interface HotelPricing {
  lines: HotelLine[];
  missing: MissingItem[];
  notes: Note[];
  usedPackages: CtxPackage[];
}

// ---------------------------------------------------------------------------
// Dates: "YYYY-MM-DD" strings, stepped in UTC so a night never shifts a day.

export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Step 1: one entry per night, in the order the traveler stays. */
export function buildNights(input: CalculateInput): Night[] {
  const legs: [City, number][] =
    input.order === 'makkah_first'
      ? [
          ['makkah', input.nightsMakkah],
          ['madinah', input.nightsMadinah],
        ]
      : [
          ['madinah', input.nightsMadinah],
          ['makkah', input.nightsMakkah],
        ];
  const nights: Night[] = [];
  for (const [city, count] of legs) {
    for (let i = 0; i < count; i += 1) {
      nights.push({ date: addDays(input.arrivalDate, nights.length), city });
    }
  }
  return nights;
}

const sar = (minor: number) => `SAR ${(minor / 100).toLocaleString('en-US')}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function sourceOf(pack: CtxPackage): PriceSource {
  return {
    packageId: pack.id,
    version: pack.version,
    packName: pack.packName,
    supplierId: pack.supplierId,
    supplierName: pack.supplierName,
    issueDate: pack.issueDate,
    nightFrom: pack.nightFrom,
    nightTo: pack.nightTo,
  };
}

/** Newest sheet first, then the latest publish, then id: always one answer. */
function preferred(a: CtxPackage, b: CtxPackage): number {
  const issue = (b.issueDate ?? '').localeCompare(a.issueDate ?? '');
  if (issue !== 0) return issue;
  const published = b.publishedAt.localeCompare(a.publishedAt);
  return published !== 0 ? published : a.id.localeCompare(b.id);
}

/** Step 2: the published pack covering this night that has a row for the hotel. */
function packageFor(ctx: PricingContext, hotelId: string, date: string) {
  const covering = ctx.packages
    .filter((p) => p.nightFrom <= date && date <= p.nightTo)
    .filter((p) => p.rates.some((r) => r.hotelId === hotelId))
    .sort(preferred);
  const pack = covering[0];
  if (!pack) return null;
  return { pack, rate: pack.rates.find((r) => r.hotelId === hotelId) as CtxHotelRate };
}

function groupRooms(input: CalculateInput): RoomGroup[] {
  const groups: RoomGroup[] = [];
  for (const room of input.rooms) {
    const same = groups.find((g) => g.occupancy === room.occupancy && g.persons === room.persons);
    if (same) same.count += 1;
    else groups.push({ occupancy: room.occupancy, persons: room.persons, count: 1 });
  }
  return groups;
}

/** Step 3: price per room per night, or why there is no price. */
function nightPrice(
  rate: CtxHotelRate,
  room: RoomGroup,
): { basis: 'per_person' | 'per_room'; unit: number } | { problem: 'on_request' | 'no_rate' } {
  if (rate.pricingMode === 'on_request') return { problem: 'on_request' };
  if (rate.pricingMode === 'flat_per_room' || room.occupancy === 'whole_room') {
    return rate.roomPriceMinor === null
      ? { problem: 'no_rate' }
      : { basis: 'per_room', unit: rate.roomPriceMinor };
  }
  const unit = rate.perPersonMinor[room.occupancy];
  return unit === null ? { problem: 'no_rate' } : { basis: 'per_person', unit };
}

function cityLabel(city: City): string {
  return city === 'makkah' ? 'Makkah' : 'Madinah';
}

function dateRange(first: string, last: string): string {
  return first === last ? first : `${first} to ${last}`;
}

/** Steps 2, 3 and 5 for one hotel over its nights. */
function priceHotel(
  ctx: PricingContext,
  hotel: CtxHotel,
  nights: Night[],
  rooms: RoomGroup[],
  markupBps: number,
  rateScaled: number,
): HotelPricing {
  const result: HotelPricing = { lines: [], missing: [], notes: [], usedPackages: [] };
  const open = new Map<string, HotelLine>();
  const gaps: { code: string; first: string; last: string; occupancy?: string }[] = [];

  const addGap = (code: string, date: string, occupancy?: string) => {
    const last = gaps.at(-1);
    if (
      last &&
      last.code === code &&
      last.occupancy === occupancy &&
      addDays(last.last, 1) === date
    ) {
      last.last = date;
    } else {
      gaps.push({ code, first: date, last: date, occupancy });
    }
  };

  for (const night of nights) {
    const found = packageFor(ctx, hotel.id, night.date);
    if (!found) {
      addGap('hotel_no_rate', night.date);
      for (const key of [...open.keys()]) open.delete(key);
      continue;
    }
    const { pack, rate } = found;
    rooms.forEach((room, index) => {
      const key = `${index}`;
      const price = nightPrice(rate, room);
      if ('problem' in price) {
        open.delete(key);
        addGap(
          price.problem === 'on_request' ? 'hotel_on_request' : 'hotel_no_occupancy_rate',
          night.date,
          price.problem === 'on_request' ? undefined : room.occupancy,
        );
        return;
      }
      const current = open.get(key);
      if (
        current &&
        current.source.packageId === pack.id &&
        current.unitMinorSAR === price.unit &&
        current.basis === price.basis &&
        addDays(current.lastNight, 1) === night.date
      ) {
        current.lastNight = night.date;
        current.nights += 1;
        return;
      }
      const line: HotelLine = {
        kind: 'hotel',
        city: hotel.city,
        hotelId: hotel.id,
        hotelName: hotel.name,
        firstNight: night.date,
        lastNight: night.date,
        nights: 1,
        occupancy: room.occupancy,
        persons: room.persons,
        rooms: room.count,
        basis: price.basis,
        unitMinorSAR: price.unit,
        amountMinorSAR: 0,
        amountMinorPKR: 0,
        source: sourceOf(pack),
        label: '',
      };
      open.set(key, line);
      result.lines.push(line);
      if (!result.usedPackages.includes(pack)) result.usedPackages.push(pack);
    });
  }

  // Step 5: amounts and labels once the groups are final.
  for (const line of result.lines) {
    const perNight = line.basis === 'per_person' ? line.persons : 1;
    const supplierAmount = line.unitMinorSAR * perNight * line.nights * line.rooms;
    line.amountMinorSAR = applyMarkupCeil(supplierAmount, markupBps);
    line.amountMinorPKR = convertSarToPkrWholeRupeesMinor(line.amountMinorSAR, rateScaled);
    const roomsPart = line.rooms > 1 ? ` × ${plural(line.rooms, 'room')}` : '';
    line.label =
      line.basis === 'per_person'
        ? `${hotel.name}, ${plural(line.nights, 'night')} × ${plural(line.persons, 'person')}${roomsPart} × ${sar(line.unitMinorSAR)}`
        : `${hotel.name}, ${plural(line.nights, 'night')}${roomsPart} × ${sar(line.unitMinorSAR)} per room`;
    if (
      line.basis === 'per_person' &&
      line.persons < OCCUPANCY_BEDS[line.occupancy as keyof typeof OCCUPANCY_BEDS]
    ) {
      result.notes.push({
        code: 'shared_room_beds',
        message: `${hotel.name}: ${line.occupancy} sharing is priced per bed. Other beds in the room may be given to other travelers — confirm with us.`,
        params: { hotel: hotel.name, occupancy: line.occupancy },
      });
    }
  }
  if (result.lines.some((l) => l.basis === 'per_room' && l.occupancy !== 'whole_room')) {
    result.notes.push({
      code: 'room_basis',
      message: `${hotel.name} is priced per room per night as printed on the supplier sheet. How many people the room holds is to be confirmed.`,
      params: { hotel: hotel.name },
    });
  }

  for (const gap of gaps) {
    const when = dateRange(gap.first, gap.last);
    const params = { hotel: hotel.name, from: gap.first, to: gap.last };
    if (gap.code === 'hotel_on_request') {
      result.missing.push({
        kind: 'hotel',
        code: gap.code,
        message: `${hotel.name} (${when}): price on request — Request a quote`,
        params,
      });
    } else if (gap.code === 'hotel_no_occupancy_rate') {
      result.missing.push({
        kind: 'hotel',
        code: gap.code,
        message: `${hotel.name} (${when}): no ${gap.occupancy} rate on the published sheet — Request a quote`,
        params: { ...params, occupancy: gap.occupancy ?? '' },
      });
    } else {
      result.missing.push({
        kind: 'hotel',
        code: gap.code,
        message: `No published rate for ${hotel.name} on ${when} — Request a quote`,
        params,
      });
    }
  }
  return result;
}

/** "cheapest" / "nearest": only hotels with a price for every night qualify. */
function pickHotel(
  ctx: PricingContext,
  choice: 'cheapest' | 'nearest',
  city: City,
  nights: Night[],
  rooms: RoomGroup[],
  markupBps: number,
  rateScaled: number,
): { hotel: CtxHotel; pricing: HotelPricing } | null {
  const candidates = ctx.hotels
    .filter((h) => h.city === city)
    .map((hotel) => ({
      hotel,
      pricing: priceHotel(ctx, hotel, nights, rooms, markupBps, rateScaled),
    }))
    .filter((c) => c.pricing.missing.length === 0 && c.pricing.lines.length > 0)
    .map((c) => ({ ...c, total: sumMinor(c.pricing.lines.map((l) => l.amountMinorSAR)) }));
  const distance = (h: CtxHotel) => h.distanceMeters ?? Number.MAX_SAFE_INTEGER;
  candidates.sort((a, b) => {
    const byPrice = a.total - b.total;
    const byDistance = distance(a.hotel) - distance(b.hotel);
    const first = choice === 'cheapest' ? byPrice : byDistance;
    const second = choice === 'cheapest' ? byDistance : byPrice;
    return first || second || a.hotel.name.localeCompare(b.hotel.name);
  });
  return candidates[0] ?? null;
}

/** Step 6. The pack is the one used for the first priced night, else any covering arrival. */
function priceVisa(
  ctx: PricingContext,
  input: CalculateInput,
  firstPack: CtxPackage | undefined,
  persons: number,
  markupBps: number,
  rateScaled: number,
): { lines: VisaLine[]; missing: MissingItem[]; notes: Note[]; pack: CtxPackage | null } {
  const pack =
    (firstPack?.visa ? firstPack : undefined) ??
    ctx.packages
      .filter((p) => p.visa && p.nightFrom <= input.arrivalDate && input.arrivalDate <= p.nightTo)
      .sort(preferred)[0];
  const out = {
    lines: [] as VisaLine[],
    missing: [] as MissingItem[],
    notes: [] as Note[],
    pack: pack ?? null,
  };
  const noRate = (code: string, message: string) =>
    out.missing.push({ kind: 'visa', code, message });

  if (!pack?.visa) {
    noRate('visa_no_rate', 'Visa: no published visa rate for your arrival date — Request a quote');
    return out;
  }
  const line = (visa: VisaLine['visa'], count: number, unit: number, label: string): VisaLine => {
    const amountMinorSAR = applyMarkupCeil(unit * count, markupBps);
    return {
      kind: 'visa',
      visa,
      persons: count,
      unitMinorSAR: unit,
      amountMinorSAR,
      amountMinorPKR: convertSarToPkrWholeRupeesMinor(amountMinorSAR, rateScaled),
      source: sourceOf(pack),
      label,
    };
  };

  if (persons > 0) {
    let unit: number | null;
    let label: string;
    if (input.visa === 'direct') {
      unit = pack.visa.directPerPersonMinor;
      label = `Umrah visa (direct flight), ${plural(persons, 'person')}`;
    } else {
      const size = String(Math.min(persons, 4)) as '1' | '2' | '3' | '4';
      unit = pack.visa.indirectByGroupSize[size];
      label = `Umrah visa (indirect flight, group of ${size}${persons > 4 ? '+' : ''}), ${plural(persons, 'person')}`;
      if (persons > 4) {
        out.notes.push({
          code: 'visa_group_5_plus',
          message: '5+ travelers priced at the 4-pax visa rate — confirm with supplier.',
        });
      }
    }
    if (unit === null)
      noRate('visa_no_rate', 'Visa: no published rate for this visa type — Request a quote');
    else out.lines.push(line(input.visa, persons, unit, `${label} × ${sar(unit)}`));
  }

  const infants = input.travelers.infants;
  if (infants > 0) {
    const unit = pack.visa.infantMinor;
    if (unit === null) {
      noRate('visa_infant_no_rate', 'Infant visa: no published rate — Request a quote');
    } else {
      out.lines.push(
        line('infant', infants, unit, `Umrah visa, ${plural(infants, 'infant')} × ${sar(unit)}`),
      );
    }
  }
  out.notes.push({
    code: 'visa_per_person_bus',
    message:
      'Visa rates are per person and include bus transport for 1–49 pax as printed on the supplier sheet — confirm with supplier.',
  });
  return out;
}

/** Step 7. Destination follows the first city: Makkah -> JED, Madinah -> MED. */
function priceFlight(
  ctx: PricingContext,
  input: CalculateInput,
  firstCity: City,
): { line: FlightLine | null; missing: MissingItem[]; exclusions: Note[] } {
  if (input.flight === 'self') {
    return {
      line: null,
      missing: [],
      exclusions: [{ code: 'flights_self', message: 'Flights: you will arrange them yourself' }],
    };
  }
  const destination = firstCity === 'makkah' ? 'JED' : 'MED';
  const today = ctx.now.toISOString().slice(0, 10);
  const city = input.departureCity.trim().toLowerCase();
  const estimate = ctx.flightEstimates
    .filter(
      (e) =>
        city !== '' &&
        e.originCity.trim().toLowerCase() === city &&
        e.destination === destination &&
        e.validTo >= today,
    )
    .sort((a, b) => b.validTo.localeCompare(a.validTo) || a.id.localeCompare(b.id))[0];

  const missing: MissingItem[] = [];
  if (!estimate) {
    missing.push({
      kind: 'flight',
      code: 'flight_no_estimate',
      message: 'Flight: request a quote',
    });
    return {
      line: null,
      missing,
      exclusions: [{ code: 'flights_missing', message: 'Flights (not priced in this estimate)' }],
    };
  }
  const adults = input.travelers.adults;
  if (input.travelers.children + input.travelers.infants > 0) {
    missing.push({
      kind: 'flight',
      code: 'flight_children',
      message: 'Flight for children and infants: request a quote',
    });
  }
  return {
    line: {
      kind: 'flight',
      originCity: estimate.originCity,
      destination,
      adults,
      lowPerAdultMinorPKR: estimate.lowMinor,
      highPerAdultMinorPKR: estimate.highMinor,
      lowMinorPKR: estimate.lowMinor * adults,
      highMinorPKR: estimate.highMinor * adults,
      estimateId: estimate.id,
      validTo: estimate.validTo,
      source: estimate.source,
      label: `Flight ${estimate.originCity} → ${destination}, ${plural(adults, 'adult')} (estimate, not a fare quote)`,
    },
    missing,
    exclusions: [],
  };
}

const EXTRA_LABELS = {
  ziyarah: 'Ziyarah',
  guide: 'Guide',
  mobility: 'Mobility support',
  transfers: 'Transfers',
} as const;

const STANDARD_EXCLUSIONS: Note[] = [
  { code: 'hotel_taxes', message: 'Hotel taxes not stated on the supplier sheet' },
  { code: 'meals', message: 'Meals' },
  { code: 'transfers', message: 'Transfers other than the visa bus' },
  { code: 'ziyarah', message: 'Ziyarah' },
  { code: 'personal', message: 'Personal expenses' },
  { code: 'request_a_quote', message: 'Anything marked "Request a quote"' },
];

/** End of the last night of a pack, in Saudi time (UTC+3, no daylight saving). */
function packEnd(nightTo: string): Date {
  return new Date(`${nightTo}T23:59:59.999+03:00`);
}

/** JSON with sorted keys, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function calculate(input: CalculateInput, ctx: PricingContext): CalculationResult {
  const markupBps = markupPercentToBps(ctx.settings.markupPercent);
  const rateScaled = parseFxRate(ctx.fx.rate);
  const nights = buildNights(input);
  const rooms = groupRooms(input);
  const lineItems: LineItem[] = [];
  const missing: MissingItem[] = [];
  const assumptions: Note[] = [];
  const used: CtxPackage[] = [];
  const use = (packs: CtxPackage[]) => packs.forEach((p) => used.includes(p) || used.push(p));

  // Steps 1-5: hotels, city by city in the order of stay.
  const cities = [...new Set(nights.map((n) => n.city))];
  for (const city of cities) {
    const cityNights = nights.filter((n) => n.city === city);
    const choice = input.hotels[city];
    if (!choice) continue; // the schema requires a choice when the city has nights
    let pricing: HotelPricing;
    if (choice === 'cheapest' || choice === 'nearest') {
      const picked = pickHotel(ctx, choice, city, cityNights, rooms, markupBps, rateScaled);
      if (!picked) {
        missing.push({
          kind: 'hotel',
          code: 'hotel_none_available',
          message: `No ${cityLabel(city)} hotel has published rates for all your nights — Request a quote`,
          params: { city },
        });
        continue;
      }
      pricing = picked.pricing;
      assumptions.push({
        code: choice === 'cheapest' ? 'hotel_picked_cheapest' : 'hotel_picked_nearest',
        message:
          choice === 'cheapest'
            ? `${picked.hotel.name} chosen as the lowest-priced ${cityLabel(city)} hotel on our published rates for your nights.`
            : `${picked.hotel.name} chosen as the nearest ${cityLabel(city)} hotel with published rates for your nights.`,
        params: { hotel: picked.hotel.name, city },
      });
    } else {
      const hotel = ctx.hotels.find((h) => h.id === choice && h.city === city);
      if (!hotel) {
        missing.push({
          kind: 'hotel',
          code: 'hotel_no_rate',
          message: `${cityLabel(city)}: the chosen hotel has no published rates — Request a quote`,
          params: { city },
        });
        continue;
      }
      pricing = priceHotel(ctx, hotel, cityNights, rooms, markupBps, rateScaled);
    }
    lineItems.push(...pricing.lines);
    missing.push(...pricing.missing);
    assumptions.push(...pricing.notes);
    use(pricing.usedPackages);
  }

  // Step 4: travelers.
  const { adults, children, infants } = input.travelers;
  const payingPersons = adults + children;
  if (infants > 0 && nights.length > 0) {
    assumptions.push({
      code: 'infant_no_hotel_charge',
      message:
        'Infants (under 2) share a bed and are not charged for hotel nights — confirm with supplier.',
    });
  }
  if (children > 0) {
    assumptions.push(
      ctx.settings.childAsAdult
        ? {
            code: 'child_as_adult',
            message:
              'Children (2–11) are priced as adults for hotel and visa — confirm with supplier.',
          }
        : {
            code: 'child_bed_priced',
            message:
              'Children take a bed in the room and are priced per bed — confirm with supplier.',
          },
    );
  }

  // Step 6: visa. Without childAsAdult, child visas are not priced.
  const visaPersons = ctx.settings.childAsAdult ? payingPersons : adults;
  const firstPack = lineItems.find((l): l is HotelLine => l.kind === 'hotel')?.source.packageId;
  const visa = priceVisa(
    ctx,
    input,
    used.find((p) => p.id === firstPack),
    visaPersons,
    markupBps,
    rateScaled,
  );
  if (!ctx.settings.childAsAdult && children > 0) {
    missing.push({
      kind: 'visa',
      code: 'visa_children',
      message: 'Visa for children: request a quote',
    });
  }
  lineItems.push(...visa.lines);
  missing.push(...visa.missing);
  assumptions.push(...visa.notes);
  if (visa.pack && visa.lines.length > 0) use([visa.pack]);

  // Step 7: flights.
  const flight = priceFlight(ctx, input, nights[0]?.city ?? 'makkah');
  if (flight.line) lineItems.push(flight.line);
  missing.push(...flight.missing);

  // Step 8: extras are always "Request a quote" in v1.
  for (const extra of input.extras) {
    missing.push({
      kind: 'extra',
      code: `extra_${extra}`,
      message: `${EXTRA_LABELS[extra]}: request a quote`,
      params: { extra },
    });
  }

  // Step 9: totals. PKR is the sum of the rounded PKR lines.
  const priced = lineItems.filter((l): l is HotelLine | VisaLine => l.kind !== 'flight');
  const groupMinorSAR = sumMinor(priced.map((l) => l.amountMinorSAR));
  const groupMinorPKR = sumMinor(priced.map((l) => l.amountMinorPKR));
  const range = flight.line
    ? {
        groupLowMinorPKR: groupMinorPKR + flight.line.lowMinorPKR,
        groupHighMinorPKR: groupMinorPKR + flight.line.highMinorPKR,
        perPersonLowMinorPKR: perPersonCeilMinor(
          groupMinorPKR + flight.line.lowMinorPKR,
          payingPersons,
        ),
        perPersonHighMinorPKR: perPersonCeilMinor(
          groupMinorPKR + flight.line.highMinorPKR,
          payingPersons,
        ),
      }
    : null;

  // Step 10: notes, expiry and hash.
  if (ctx.settings.markupPercent > 0) {
    assumptions.push({ code: 'markup_applied', message: 'Prices include our service charge.' });
  }
  assumptions.push({ code: 'rates_can_change', message: 'Rates can change without notice.' });

  const exclusions: Note[] = [...flight.exclusions, ...STANDARD_EXCLUSIONS];
  const rateVersionSnapshot = used
    .map((p) => ({
      packageId: p.id,
      version: p.version,
      supplierId: p.supplierId,
      issueDate: p.issueDate,
    }))
    .sort((a, b) => a.packageId.localeCompare(b.packageId));

  const byExpiry = ctx.now.getTime() + ctx.settings.estimateExpiryHours * 3_600_000;
  const packEnds = used.map((p) => packEnd(p.nightTo).getTime());
  const expiresAt = new Date(Math.min(byExpiry, ...packEnds));

  const hash = createHash('sha256')
    .update(
      canonicalJson({
        engineVersion: ENGINE_VERSION,
        inputs: input,
        versions: rateVersionSnapshot,
        fx: ctx.fx.rate,
        markupPercent: ctx.settings.markupPercent,
        childAsAdult: ctx.settings.childAsAdult,
        infantHotelCharge: ctx.settings.infantHotelCharge,
        flight: flight.line
          ? [
              flight.line.estimateId,
              flight.line.lowPerAdultMinorPKR,
              flight.line.highPerAdultMinorPKR,
            ]
          : null,
      }),
    )
    .digest('hex');

  return {
    inputs: input,
    rateVersionSnapshot,
    fx: { rate: ctx.fx.rate, effectiveAt: ctx.fx.effectiveAt },
    markupPercent: ctx.settings.markupPercent,
    lineItems,
    missing,
    assumptions: dedupe(assumptions),
    exclusions,
    totals: {
      groupMinorSAR,
      groupMinorPKR,
      perPersonMinorSAR: perPersonCeilMinor(groupMinorSAR, payingPersons),
      perPersonMinorPKR: perPersonCeilMinor(groupMinorPKR, payingPersons),
      payingPersons,
      isPartial: missing.length > 0 || range !== null,
      range,
    },
    calculatedAt: ctx.now,
    expiresAt,
    hash,
    engineVersion: ENGINE_VERSION,
  };
}

function dedupe(notes: Note[]): Note[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = `${note.code}|${note.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
