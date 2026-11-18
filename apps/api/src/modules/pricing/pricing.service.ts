/**
 * Loads the pricing context from the database and runs the pure engine
 * (docs/03 section 6). Also saves calculations as snapshots and lists the
 * hotels the public calculator can offer.
 */
import {
  CalculationResultSchema,
  convertSarToPkrWholeRupeesMinor,
  parseFxRate,
  type CalculateInput,
  type CalculationResult,
  type PublicFromPrice,
  type PublicHotel,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import { HttpError, notFound } from '../../lib/http-error.js';
import { FlightEstimateModel } from '../flight-estimates/flight-estimate.model.js';
import { today } from '../flight-estimates/flight-estimates.service.js';
import { getCurrentFx } from '../fx/fx.service.js';
import { HotelModel } from '../hotels/hotel.model.js';
import {
  HotelRateModel,
  RatePackageModel,
  VisaRateModel,
} from '../rate-sheets/rate-sheet.models.js';
import { getSettings } from '../settings/settings.service.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { CalculationModel } from './calculation.model.js';
import { addDays, calculate, type CtxPackage, type PricingContext } from './engine.js';

const id = (value: unknown) => String(value);

/** Today's date in Pakistan (UTC+5, no daylight saving), where customers are. */
export function todayInPakistan(at: Date = new Date()): string {
  return new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
}

const pricesUnavailable = () =>
  new HttpError(
    503,
    'prices_unavailable',
    'Prices are not available right now. Please request a quote and we will reply.',
  );

/** Published packs (with rows, visa and supplier name) overlapping [from, to]. */
async function loadPublishedPackages(from: string, to: string): Promise<CtxPackage[]> {
  const packs = await RatePackageModel.find({
    status: 'published',
    nightFrom: { $ne: null, $lte: to },
    nightTo: { $ne: null, $gte: from },
  }).lean();
  if (packs.length === 0) return [];

  const packIds = packs.map((p) => p._id);
  const [rates, visas, suppliers] = await Promise.all([
    HotelRateModel.find({
      packageId: { $in: packIds },
      hotelId: { $exists: true, $ne: null },
    }).lean(),
    VisaRateModel.find({ packageId: { $in: packIds } }).lean(),
    SupplierModel.find({ _id: { $in: [...new Set(packs.map((p) => id(p.supplierId)))] } })
      .select('name')
      .lean(),
  ]);
  const supplierName = new Map(suppliers.map((s) => [id(s._id), s.name]));

  return packs.map((pack) => {
    const visa = visas.find((v) => id(v.packageId) === id(pack._id));
    return {
      id: id(pack._id),
      version: pack.version,
      supplierId: id(pack.supplierId),
      supplierName: supplierName.get(id(pack.supplierId)) ?? '',
      packName: pack.packName,
      nightFrom: pack.nightFrom as string,
      nightTo: pack.nightTo as string,
      issueDate: pack.issueDate ?? null,
      publishedAt: (pack.publishedAt ?? pack.updatedAt).toISOString(),
      rates: rates
        .filter((r) => id(r.packageId) === id(pack._id))
        .map((r) => ({
          hotelId: id(r.hotelId),
          pricingMode: r.pricingMode as CtxPackage['rates'][number]['pricingMode'],
          roomPriceMinor: r.roomPriceMinor ?? null,
          perPersonMinor: {
            quint: r.perPersonMinor?.quint ?? null,
            quad: r.perPersonMinor?.quad ?? null,
            triple: r.perPersonMinor?.triple ?? null,
            double: r.perPersonMinor?.double ?? null,
          },
        })),
      visa: visa
        ? {
            directPerPersonMinor: visa.direct?.perPersonMinor ?? null,
            indirectByGroupSize: {
              '1': visa.indirectByGroupSize?.['1'] ?? null,
              '2': visa.indirectByGroupSize?.['2'] ?? null,
              '3': visa.indirectByGroupSize?.['3'] ?? null,
              '4': visa.indirectByGroupSize?.['4'] ?? null,
            },
            infantMinor: visa.infantMinor ?? null,
          }
        : null,
    };
  });
}

/** Everything `calculate()` needs for these inputs, read once. */
export async function loadContext(
  input: CalculateInput,
  now: Date = new Date(),
): Promise<PricingContext> {
  const totalNights = input.nightsMakkah + input.nightsMadinah;
  const lastNight = addDays(input.arrivalDate, Math.max(totalNights - 1, 0));

  const [settings, fx, packages, hotels, flightEstimates] = await Promise.all([
    getSettings(),
    getCurrentFx(now),
    loadPublishedPackages(input.arrivalDate, lastNight),
    HotelModel.find({ active: true, mergedIntoId: null }).lean(),
    input.flight === 'estimate'
      ? FlightEstimateModel.find({ validTo: { $gte: today(now) } }).lean()
      : Promise.resolve([]),
  ]);
  if (!fx) throw pricesUnavailable();

  return {
    now,
    settings: {
      markupPercent: settings.markupPercent,
      estimateExpiryHours: settings.estimateExpiryHours,
      childAsAdult: settings.childAsAdult,
      infantHotelCharge: 'none',
    },
    fx: { rate: fx.rate, effectiveAt: fx.effectiveAt },
    hotels: hotels.map((h) => ({
      id: id(h._id),
      city: h.city as 'makkah' | 'madinah',
      name: h.canonicalName,
      distanceMeters: h.distanceMeters ?? null,
    })),
    packages,
    flightEstimates: flightEstimates.map((e) => ({
      id: id(e._id),
      originCity: e.originCity,
      destination: e.destination as 'JED' | 'MED',
      lowMinor: e.lowMinor,
      highMinor: e.highMinor,
      validTo: e.validTo,
      source: e.source,
    })),
  };
}

/** POST /public/calculate: price the inputs now. Nothing is saved. */
export async function calculateNow(
  input: CalculateInput,
  now: Date = new Date(),
): Promise<CalculationResult> {
  if (input.arrivalDate < todayInPakistan(now)) {
    throw new HttpError(400, 'validation_error', 'Please check the highlighted fields', {
      arrivalDate: 'Choose today or a later date',
    });
  }
  return calculate(input, await loadContext(input, now));
}

/** Store a result as an immutable snapshot (used by inquiries in Phase 6). */
export async function saveCalculation(result: CalculationResult): Promise<string> {
  const valid = CalculationResultSchema.parse(result);
  const doc = await CalculationModel.create(valid);
  return doc.id as string;
}

/** A saved calculation exactly as it was stored. Never recalculated. */
export async function getCalculation(calculationId: string): Promise<CalculationResult> {
  const doc = mongoose.isValidObjectId(calculationId)
    ? await CalculationModel.findById(calculationId).lean()
    : null;
  if (!doc) throw notFound('Calculation');
  const {
    _id,
    __v,
    createdAt: _c,
    updatedAt: _u,
    ...stored
  } = doc as typeof doc & { __v?: number };
  void _id;
  void __v;
  return CalculationResultSchema.parse(stored);
}

/**
 * GET /public/hotels: active hotels with a row in a published pack that has
 * not ended, with their lowest published price. Supplier contact details and
 * internal notes are never read here.
 */
export async function listPublicHotels(
  city: 'makkah' | 'madinah' | undefined,
  now: Date = new Date(),
): Promise<PublicHotel[]> {
  const [settings, fx] = await Promise.all([getSettings(), getCurrentFx(now)]);
  const packages = await loadPublishedPackages(todayInPakistan(now), '9999-12-31');
  const hotelIds = [...new Set(packages.flatMap((p) => p.rates.map((r) => r.hotelId)))];
  const hotels = await HotelModel.find({
    _id: { $in: hotelIds },
    active: true,
    mergedIntoId: null,
    ...(city ? { city } : {}),
  }).lean();

  const rateScaled = fx ? parseFxRate(fx.rate) : null;
  const price = (minorSAR: number, pack: CtxPackage): PublicFromPrice => ({
    minorSAR: settings.showSupplierRates ? minorSAR : null,
    minorPKR: rateScaled === null ? null : convertSarToPkrWholeRupeesMinor(minorSAR, rateScaled),
    supplierName: pack.supplierName,
    packName: pack.packName,
    issueDate: pack.issueDate,
  });

  const list = hotels.map((hotel): PublicHotel => {
    const rows = packages.flatMap((pack) =>
      pack.rates.filter((r) => r.hotelId === id(hotel._id)).map((rate) => ({ pack, rate })),
    );
    let perPerson: { amount: number; pack: CtxPackage } | null = null;
    let perRoom: { amount: number; pack: CtxPackage } | null = null;
    for (const { pack, rate } of rows) {
      if (rate.pricingMode === 'derived_per_person') {
        const values = Object.values(rate.perPersonMinor).filter((v): v is number => v !== null);
        const lowest = values.length ? Math.min(...values) : null;
        if (lowest !== null && (!perPerson || lowest < perPerson.amount))
          perPerson = { amount: lowest, pack };
      } else if (rate.pricingMode === 'flat_per_room' && rate.roomPriceMinor !== null) {
        if (!perRoom || rate.roomPriceMinor < perRoom.amount)
          perRoom = { amount: rate.roomPriceMinor, pack };
      }
    }
    return {
      id: id(hotel._id),
      city: hotel.city as 'makkah' | 'madinah',
      name: hotel.canonicalName,
      distanceMeters: hotel.distanceMeters ?? null,
      distanceNote: hotel.distanceNote ?? '',
      transport: hotel.transport as PublicHotel['transport'],
      ratesFrom: rows.map((r) => r.pack.nightFrom).sort()[0] as string,
      ratesTo: rows
        .map((r) => r.pack.nightTo)
        .sort()
        .at(-1) as string,
      fromPerPerson: perPerson ? price(perPerson.amount, perPerson.pack) : null,
      fromPerRoom: perRoom ? price(perRoom.amount, perRoom.pack) : null,
      onRequestOnly: rows.every((r) => r.rate.pricingMode === 'on_request'),
    };
  });
  return list.sort(
    (a, b) =>
      a.city.localeCompare(b.city) ||
      (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) -
        (b.distanceMeters ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  );
}
