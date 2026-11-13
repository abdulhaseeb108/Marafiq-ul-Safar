/**
 * Rate packs: views, validation, review edits, and the publish / reject /
 * rollback lifecycle (docs/03 sections 2 and 4).
 *
 * A published pack is never changed in place. Edits are only possible before
 * publishing; a correction afterwards is a new pack that supersedes the old one.
 */
import {
  RATE_PACKAGE_TRANSITIONS,
  assertTransition,
  type AddHotelRateBody,
  type City,
  type ConfirmHotelBody,
  type HotelRateView,
  type PackageValidation,
  type Paged,
  type PricingMode,
  type RatePackageDetail,
  type RatePackageListQuery,
  type RatePackageStatus,
  type RatePackageSummary,
  type UpdateHotelRateBody,
  type UpdateRatePackageBody,
  type VisaRateView,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import { HttpError, notFound } from '../../lib/http-error.js';
import { inTransaction } from '../../lib/transaction.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { HotelModel } from '../hotels/hotel.model.js';
import { createHotel, updateHotel } from '../hotels/hotels.service.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { UserModel } from '../users/user.model.js';
import {
  HotelRateModel,
  RatePackageModel,
  SourceDocumentModel,
  VisaRateModel,
  type HotelRateDoc,
  type RatePackageDoc,
  type VisaRateDoc,
} from './rate-sheet.models.js';
import { validatePackage, type ValidationInput } from './validation.js';

const EDITABLE: readonly RatePackageStatus[] = ['draft', 'needs_review'];

const id = (value: unknown): string => String(value);
const today = (): string => new Date().toISOString().slice(0, 10);

// --- loading --------------------------------------------------------------
export async function findPackageOr404(packageId: string): Promise<RatePackageDoc> {
  const pack = mongoose.isValidObjectId(packageId)
    ? await RatePackageModel.findById(packageId)
    : null;
  if (!pack) throw notFound('Rate pack');
  return pack;
}

async function findRateOr404(rateId: string): Promise<HotelRateDoc> {
  const rate = mongoose.isValidObjectId(rateId) ? await HotelRateModel.findById(rateId) : null;
  if (!rate) throw notFound('Rate row');
  return rate;
}

function assertEditable(pack: RatePackageDoc): void {
  if (!EDITABLE.includes(pack.status as RatePackageStatus)) {
    throw new HttpError(
      409,
      'not_editable',
      'This pack can no longer be edited. To correct a published pack, upload the new sheet and publish it as a replacement.',
    );
  }
}

const sortedRates = (packageId: mongoose.Types.ObjectId) =>
  HotelRateModel.find({ packageId }).sort({ sourcePage: 1, sourceRow: 1, _id: 1 });

// --- views ----------------------------------------------------------------
export function toSummary(pack: RatePackageDoc): RatePackageSummary {
  return {
    id: pack.id as string,
    supplierId: id(pack.supplierId),
    sourceDocumentId: id(pack.sourceDocumentId),
    packName: pack.packName,
    seasonLabel: pack.seasonLabel ?? null,
    nightFrom: pack.nightFrom ?? null,
    nightTo: pack.nightTo ?? null,
    issueDate: pack.issueDate ?? null,
    status: pack.status as RatePackageStatus,
    version: pack.version,
    blockingCount: pack.validation?.blocking.length ?? 0,
    warningCount: pack.validation?.warnings.length ?? 0,
    publishedAt: pack.publishedAt ?? null,
  };
}

function toVisaView(visa: VisaRateDoc | null): VisaRateView {
  return {
    directPerPersonMinor: visa?.direct?.perPersonMinor ?? null,
    indirectByGroupSizeMinor: {
      '1': visa?.indirectByGroupSize?.['1'] ?? null,
      '2': visa?.indirectByGroupSize?.['2'] ?? null,
      '3': visa?.indirectByGroupSize?.['3'] ?? null,
      '4': visa?.indirectByGroupSize?.['4'] ?? null,
    },
    infantMinor: visa?.infantMinor ?? null,
    appliesNote: visa?.appliesNote ?? null,
  };
}

function toRateView(rate: HotelRateDoc, hotelNames: Map<string, string>): HotelRateView {
  const hotelId = rate.hotelId ? id(rate.hotelId) : null;
  const suggestedHotelId = rate.suggestedHotelId ? id(rate.suggestedHotelId) : null;
  return {
    id: rate.id as string,
    packageId: id(rate.packageId),
    hotelId,
    hotelName: hotelId ? (hotelNames.get(hotelId) ?? null) : null,
    printed: {
      city: rate.printed?.city as City,
      name: rate.printed?.name ?? '',
      aliases: [...(rate.printed?.aliases ?? [])],
      distanceText: rate.printed?.distanceText ?? null,
      distanceMeters: rate.printed?.distanceMeters ?? null,
      transportText: rate.printed?.transportText ?? null,
    },
    suggestedHotelId,
    suggestedHotelName: suggestedHotelId ? (hotelNames.get(suggestedHotelId) ?? null) : null,
    pricingMode: rate.pricingMode as PricingMode,
    roomPriceMinor: rate.roomPriceMinor ?? null,
    perPersonMinor: {
      quint: rate.perPersonMinor?.quint ?? null,
      quad: rate.perPersonMinor?.quad ?? null,
      triple: rate.perPersonMinor?.triple ?? null,
      double: rate.perPersonMinor?.double ?? null,
    },
    flatNote: rate.flatNote ?? null,
    sourcePage: rate.sourcePage,
    sourceRow: rate.sourceRow,
    confidence: rate.confidence,
    edited: rate.edited,
  };
}

async function hotelNamesFor(rates: HotelRateDoc[]): Promise<Map<string, string>> {
  const ids = rates.flatMap((rate) => [rate.hotelId, rate.suggestedHotelId]).filter(Boolean);
  const hotels = await HotelModel.find({ _id: { $in: ids } })
    .select('canonicalName')
    .lean();
  return new Map(hotels.map((hotel) => [id(hotel._id), hotel.canonicalName]));
}

function datesOverlap(a: RatePackageDoc, b: RatePackageDoc): boolean {
  if (!a.nightFrom || !a.nightTo || !b.nightFrom || !b.nightTo) return true;
  return a.nightFrom <= b.nightTo && b.nightFrom <= a.nightTo;
}

export async function getPackageDetail(packageId: string): Promise<RatePackageDetail> {
  const pack = await findPackageOr404(packageId);
  const [rates, visa, supplier, publisher, published, previous] = await Promise.all([
    sortedRates(pack._id),
    VisaRateModel.findOne({ packageId: pack._id }),
    SupplierModel.findById(pack.supplierId).select('name').lean(),
    pack.publishedBy ? UserModel.findById(pack.publishedBy).select('name').lean() : null,
    RatePackageModel.find({
      supplierId: pack.supplierId,
      status: 'published',
      _id: { $ne: pack._id },
    }),
    pack.supersedesId ? RatePackageModel.exists({ _id: pack.supersedesId }) : null,
  ]);
  const names = await hotelNamesFor(rates);

  return {
    ...toSummary(pack),
    supplierName: supplier?.name ?? '',
    effectiveFrom: pack.effectiveFrom ?? null,
    currency: pack.currency,
    supersedesId: pack.supersedesId ? id(pack.supersedesId) : null,
    publishedByName: publisher?.name ?? null,
    validation: {
      blocking: (pack.validation?.blocking ?? []).map(plainIssue),
      warnings: (pack.validation?.warnings ?? []).map(plainIssue),
    },
    visa: toVisaView(visa),
    rates: rates.map((rate) => toRateView(rate, names)),
    replaceable: published
      .filter((other) => datesOverlap(pack, other))
      .map((other) => ({
        id: other.id as string,
        packName: other.packName,
        nightFrom: other.nightFrom ?? null,
        nightTo: other.nightTo ?? null,
      })),
    canRollback: pack.status === 'published' && previous !== null,
  };
}

const plainIssue = (issue: {
  code?: string | null;
  message?: string | null;
  path?: string | null;
}) => ({
  code: issue.code ?? '',
  message: issue.message ?? '',
  ...(issue.path ? { path: issue.path } : {}),
});

export async function listPackages(
  query: RatePackageListQuery,
): Promise<Paged<RatePackageSummary>> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.supplierId) filter.supplierId = query.supplierId;
  const [packs, total] = await Promise.all([
    RatePackageModel.find(filter)
      .sort({ nightFrom: 1, version: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    RatePackageModel.countDocuments(filter),
  ]);
  return { items: packs.map(toSummary), page: query.page, limit: query.limit, total };
}

// --- validation -----------------------------------------------------------
/** Gather what the pure validator needs, run it, and store the result. */
export async function revalidate(pack: RatePackageDoc): Promise<PackageValidation> {
  const [rates, visa, others] = await Promise.all([
    sortedRates(pack._id),
    VisaRateModel.findOne({ packageId: pack._id }),
    RatePackageModel.find({ supplierId: pack.supplierId, _id: { $ne: pack._id } }),
  ]);
  const names = await hotelNamesFor(rates);

  const publishedIds = others.filter((o) => o.status === 'published').map((o) => o._id);
  const historyIds = others
    .filter((o) => o.status === 'published' || o.status === 'superseded')
    .map((o) => o._id);
  const [publishedRates, flatHotelIds] = await Promise.all([
    HotelRateModel.find({ packageId: { $in: publishedIds } })
      .select('packageId hotelId pricingMode roomPriceMinor')
      .lean(),
    HotelRateModel.distinct('hotelId', {
      packageId: { $in: historyIds },
      pricingMode: 'flat_per_room',
    }),
  ]);
  const ratesByPack = new Map<string, ValidationInput['others'][number]['rates']>();
  for (const rate of publishedRates) {
    const list = ratesByPack.get(id(rate.packageId)) ?? [];
    list.push({
      hotelId: rate.hotelId ? id(rate.hotelId) : null,
      pricingMode: rate.pricingMode as PricingMode,
      roomPriceMinor: rate.roomPriceMinor ?? null,
    });
    ratesByPack.set(id(rate.packageId), list);
  }

  const result = validatePackage({
    pack: {
      id: pack.id as string,
      nightFrom: pack.nightFrom ?? null,
      nightTo: pack.nightTo ?? null,
      currency: pack.currency,
      issueDate: pack.issueDate ?? null,
      seasonLabel: pack.seasonLabel ?? null,
      supersedesId: pack.supersedesId ? id(pack.supersedesId) : null,
    },
    rates: rates.map((rate) => {
      const view = toRateView(rate, names);
      return {
        id: view.id,
        hotelId: view.hotelId,
        label: view.hotelName ?? view.printed.name,
        pricingMode: view.pricingMode,
        roomPriceMinor: view.roomPriceMinor,
        perPersonMinor: view.perPersonMinor,
        confidence: view.confidence,
        edited: view.edited,
      };
    }),
    visa: visa ? toVisaView(visa) : null,
    others: others.map((o) => ({
      id: o.id as string,
      packName: o.packName,
      status: o.status as RatePackageStatus,
      nightFrom: o.nightFrom ?? null,
      nightTo: o.nightTo ?? null,
      issueDate: o.issueDate ?? null,
      seasonLabel: o.seasonLabel ?? null,
      rates: ratesByPack.get(o.id as string) ?? [],
    })),
    knownFlatHotelIds: new Set(flatHotelIds.filter(Boolean).map(id)),
    today: today(),
  });

  pack.set('validation', result);
  if (pack.status === 'draft') {
    assertTransition(RATE_PACKAGE_TRANSITIONS, 'draft', 'needs_review');
    pack.status = 'needs_review';
  }
  await pack.save();
  return result;
}

export async function validateAndView(packageId: string): Promise<RatePackageDetail> {
  const pack = await findPackageOr404(packageId);
  if (EDITABLE.includes(pack.status as RatePackageStatus)) await revalidate(pack);
  return getPackageDetail(packageId);
}

/** Keep the document's status in step with the packs made from it. */
export async function syncDocumentStatus(sourceDocumentId: mongoose.Types.ObjectId): Promise<void> {
  const statuses = await RatePackageModel.distinct('status', { sourceDocumentId });
  if (statuses.length === 0) return;
  let status: 'published' | 'needs_review' | 'superseded' | 'rejected' = 'rejected';
  if (statuses.includes('published')) status = 'published';
  else if (statuses.includes('needs_review') || statuses.includes('draft')) status = 'needs_review';
  else if (statuses.includes('superseded')) status = 'superseded';
  await SourceDocumentModel.updateOne(
    { _id: sourceDocumentId, extractionStatus: { $ne: 'extracting' } },
    { extractionStatus: status },
  );
}

// --- review edits ---------------------------------------------------------
const packSnapshot = (pack: RatePackageDoc) => ({
  packName: pack.packName,
  seasonLabel: pack.seasonLabel ?? null,
  nightFrom: pack.nightFrom ?? null,
  nightTo: pack.nightTo ?? null,
  effectiveFrom: pack.effectiveFrom ?? null,
  issueDate: pack.issueDate ?? null,
  status: pack.status,
  version: pack.version,
  supersedesId: pack.supersedesId ? id(pack.supersedesId) : null,
});

export async function updatePackage(
  packageId: string,
  body: UpdateRatePackageBody,
  actor: Actor,
): Promise<RatePackageDetail> {
  const pack = await findPackageOr404(packageId);
  assertEditable(pack);
  const visaDoc =
    (await VisaRateModel.findOne({ packageId: pack._id })) ??
    new VisaRateModel({ packageId: pack._id });
  const before = { ...packSnapshot(pack), visa: toVisaView(visaDoc) };

  if (body.supersedesId !== undefined) {
    if (body.supersedesId !== null) {
      const target =
        body.supersedesId === pack.id ? null : await RatePackageModel.findById(body.supersedesId);
      if (
        !target ||
        target.status !== 'published' ||
        id(target.supplierId) !== id(pack.supplierId)
      ) {
        throw new HttpError(
          400,
          'invalid_replacement',
          'A pack can only replace a published pack from the same supplier.',
        );
      }
    }
    pack.set('supersedesId', body.supersedesId);
  }
  if (body.packName !== undefined) pack.packName = body.packName;
  if (body.seasonLabel !== undefined) pack.set('seasonLabel', body.seasonLabel ?? undefined);
  if (body.nightFrom !== undefined) pack.nightFrom = body.nightFrom;
  if (body.nightTo !== undefined) pack.nightTo = body.nightTo;
  if (body.effectiveFrom !== undefined) pack.effectiveFrom = body.effectiveFrom;
  if (body.issueDate !== undefined) pack.issueDate = body.issueDate;

  if (body.visa) {
    const { visa } = body;
    if (visa.directPerPersonMinor !== undefined) {
      visaDoc.set('direct.perPersonMinor', visa.directPerPersonMinor);
    }
    for (const size of ['1', '2', '3', '4'] as const) {
      const amount = visa.indirectByGroupSizeMinor?.[size];
      if (amount !== undefined) visaDoc.set(`indirectByGroupSize.${size}`, amount);
    }
    if (visa.infantMinor !== undefined) visaDoc.infantMinor = visa.infantMinor;
    if (visa.appliesNote !== undefined) visaDoc.set('appliesNote', visa.appliesNote ?? undefined);
    await visaDoc.save();
  }
  await pack.save();
  await revalidate(pack);

  await recordAudit({
    actor,
    action: 'ratePackage.update',
    entityType: 'ratePackage',
    entityId: pack.id as string,
    before,
    after: { ...packSnapshot(pack), visa: toVisaView(visaDoc) },
    ip: actor.ip,
  });
  return getPackageDetail(packageId);
}

const rateSnapshot = (rate: HotelRateDoc) => ({
  hotelId: rate.hotelId ? id(rate.hotelId) : null,
  printedName: rate.printed?.name,
  pricingMode: rate.pricingMode,
  roomPriceMinor: rate.roomPriceMinor ?? null,
  perPersonMinor: {
    quint: rate.perPersonMinor?.quint ?? null,
    quad: rate.perPersonMinor?.quad ?? null,
    triple: rate.perPersonMinor?.triple ?? null,
    double: rate.perPersonMinor?.double ?? null,
  },
  flatNote: rate.flatNote ?? null,
  edited: rate.edited,
});

async function editableRate(rateId: string): Promise<{ rate: HotelRateDoc; pack: RatePackageDoc }> {
  const rate = await findRateOr404(rateId);
  const pack = await findPackageOr404(id(rate.packageId));
  assertEditable(pack);
  return { rate, pack };
}

/** Change a row's figures. Marks it edited, so reviewers can see a person touched it. */
export async function updateHotelRate(
  rateId: string,
  body: UpdateHotelRateBody,
  actor: Actor,
): Promise<RatePackageDetail> {
  const { rate, pack } = await editableRate(rateId);
  const before = rateSnapshot(rate);

  if (body.pricingMode !== undefined) rate.pricingMode = body.pricingMode;
  if (body.roomPriceMinor !== undefined) rate.roomPriceMinor = body.roomPriceMinor;
  for (const key of ['quint', 'quad', 'triple', 'double'] as const) {
    const amount = body.perPersonMinor?.[key];
    if (amount !== undefined) rate.set(`perPersonMinor.${key}`, amount);
  }
  if (body.flatNote !== undefined) rate.set('flatNote', body.flatNote ?? undefined);
  rate.edited = true;
  await rate.save();
  await revalidate(pack);

  await recordAudit({
    actor,
    action: 'hotelRate.update',
    entityType: 'hotelRate',
    entityId: rate.id as string,
    before,
    after: rateSnapshot(rate),
    ip: actor.ip,
  });
  return getPackageDetail(pack.id as string);
}

const alreadyInPack = () =>
  new HttpError(409, 'hotel_already_in_pack', 'That hotel already has a row in this pack.');

export async function addHotelRate(
  packageId: string,
  body: AddHotelRateBody,
  actor: Actor,
): Promise<RatePackageDetail> {
  const pack = await findPackageOr404(packageId);
  assertEditable(pack);
  const hotel = await HotelModel.findById(body.hotelId);
  if (!hotel || hotel.mergedIntoId) throw notFound('Hotel');
  if (await HotelRateModel.exists({ packageId: pack._id, hotelId: hotel._id }))
    throw alreadyInPack();

  const last = await HotelRateModel.findOne({ packageId: pack._id }).sort({ sourceRow: -1 });
  const rate = await HotelRateModel.create({
    packageId: pack._id,
    hotelId: hotel._id,
    printed: { city: hotel.city, name: hotel.canonicalName },
    pricingMode: body.pricingMode,
    roomPriceMinor: body.roomPriceMinor,
    perPersonMinor: {
      quint: body.perPersonMinor.quint ?? null,
      quad: body.perPersonMinor.quad ?? null,
      triple: body.perPersonMinor.triple ?? null,
      double: body.perPersonMinor.double ?? null,
    },
    flatNote: body.flatNote ?? undefined,
    sourcePage: last?.sourcePage ?? 1,
    sourceRow: (last?.sourceRow ?? 0) + 1,
    confidence: 1, // typed by a person, not read by the model
    edited: true,
  });
  await revalidate(pack);
  await recordAudit({
    actor,
    action: 'hotelRate.create',
    entityType: 'hotelRate',
    entityId: rate.id as string,
    after: rateSnapshot(rate),
    ip: actor.ip,
  });
  return getPackageDetail(packageId);
}

/**
 * Remove a row from an unpublished pack (the model read a row that is not on
 * the sheet, or read one twice). Rows of published packs are never deleted.
 */
export async function deleteHotelRate(rateId: string, actor: Actor): Promise<RatePackageDetail> {
  const { rate, pack } = await editableRate(rateId);
  const before = rateSnapshot(rate);
  await rate.deleteOne();
  await revalidate(pack);
  await recordAudit({
    actor,
    action: 'hotelRate.delete',
    entityType: 'hotelRate',
    entityId: rate.id as string,
    before,
    ip: actor.ip,
  });
  return getPackageDetail(pack.id as string);
}

/** Staff decide what an unrecognised printed name means. */
export async function confirmHotel(
  rateId: string,
  body: ConfirmHotelBody,
  actor: Actor,
): Promise<RatePackageDetail> {
  const { rate, pack } = await editableRate(rateId);
  const before = rateSnapshot(rate);
  const printed = rate.printed;
  if (!printed) throw notFound('Rate row');

  let hotelId: string;
  if (body.action === 'create') {
    const hotel = await createHotel(
      {
        city: printed.city as City,
        canonicalName: printed.name,
        aliases: [...printed.aliases],
        distanceMeters: printed.distanceMeters ?? null,
        distanceNote: printed.distanceText ?? '',
        transport: /shuttle|bus/i.test(printed.transportText ?? '')
          ? 'shuttle'
          : /walk/i.test(printed.transportText ?? '')
            ? 'walking'
            : 'unknown',
        starRating: null,
      },
      actor,
    );
    hotelId = hotel.id;
  } else {
    const hotel = await HotelModel.findById(body.hotelId);
    if (!hotel || hotel.mergedIntoId) throw notFound('Hotel');
    if (hotel.city !== printed.city) {
      throw new HttpError(
        400,
        'different_city',
        `"${printed.name}" is listed under ${printed.city}, but ${hotel.canonicalName} is in ${hotel.city}.`,
      );
    }
    if (await HotelRateModel.exists({ packageId: pack._id, hotelId: hotel._id })) {
      throw alreadyInPack();
    }
    // Remember the printed spelling so the next sheet matches by itself.
    await updateHotel(hotel.id as string, { aliases: [...hotel.aliases, printed.name] }, actor);
    hotelId = hotel.id as string;
  }

  rate.set('hotelId', hotelId);
  rate.set('suggestedHotelId', undefined);
  await rate.save();
  await revalidate(pack);
  await recordAudit({
    actor,
    action: 'hotelRate.confirm_hotel',
    entityType: 'hotelRate',
    entityId: rate.id as string,
    before,
    after: { ...rateSnapshot(rate), how: body.action },
    ip: actor.ip,
  });
  return getPackageDetail(pack.id as string);
}

// --- lifecycle ------------------------------------------------------------
export async function publishPackage(
  packageId: string,
  acknowledgeWarnings: boolean,
  actor: Actor,
): Promise<RatePackageDetail> {
  const pack = await findPackageOr404(packageId);
  if (!EDITABLE.includes(pack.status as RatePackageStatus)) {
    throw new HttpError(409, 'not_publishable', `A ${pack.status} pack cannot be published.`);
  }

  // Never trust a stored result: other packs may have changed since.
  const validation = await revalidate(pack);
  if (validation.blocking.length > 0) {
    throw new HttpError(
      409,
      'blocking_errors',
      `This pack has ${validation.blocking.length} problem(s) that must be fixed before publishing.`,
    );
  }
  if (validation.warnings.length > 0 && !acknowledgeWarnings) {
    throw new HttpError(
      409,
      'warnings_not_acknowledged',
      `This pack has ${validation.warnings.length} warning(s). Read them and confirm before publishing.`,
    );
  }

  const before = packSnapshot(pack);
  await inTransaction(async () => {
    let version = 1;
    if (pack.supersedesId) {
      const replaced = await RatePackageModel.findById(pack.supersedesId);
      if (replaced?.status === 'published') {
        // First, so that if anything stops half-way no two packs cover one night.
        assertTransition(RATE_PACKAGE_TRANSITIONS, 'published', 'superseded');
        replaced.status = 'superseded';
        await replaced.save();
        await recordAudit({
          actor,
          action: 'ratePackage.supersede',
          entityType: 'ratePackage',
          entityId: replaced.id as string,
          before: { status: 'published' },
          after: { status: 'superseded', supersededBy: pack.id as string },
          ip: actor.ip,
        });
      }
      version = (replaced?.version ?? 0) + 1;
    }

    assertTransition(RATE_PACKAGE_TRANSITIONS, 'needs_review', 'published');
    pack.status = 'published';
    pack.version = version;
    pack.publishedAt = new Date();
    pack.set('publishedBy', actor.id ?? null);
    await pack.save();
    await syncDocumentStatus(pack.sourceDocumentId);
    await recordAudit({
      actor,
      action: 'ratePackage.publish',
      entityType: 'ratePackage',
      entityId: pack.id as string,
      before,
      after: { ...packSnapshot(pack), warningsAcknowledged: validation.warnings.length },
      ip: actor.ip,
    });
  });
  return getPackageDetail(packageId);
}

export async function rejectPackage(
  packageId: string,
  reason: string | undefined,
  actor: Actor,
): Promise<RatePackageDetail> {
  const pack = await findPackageOr404(packageId);
  const from = pack.status as RatePackageStatus;
  if (!EDITABLE.includes(from)) {
    throw new HttpError(409, 'not_rejectable', `A ${from} pack cannot be rejected.`);
  }
  assertTransition(RATE_PACKAGE_TRANSITIONS, from, 'rejected');
  const before = packSnapshot(pack);
  pack.status = 'rejected';
  await pack.save();
  await syncDocumentStatus(pack.sourceDocumentId);
  await recordAudit({
    actor,
    action: 'ratePackage.reject',
    entityType: 'ratePackage',
    entityId: pack.id as string,
    before,
    after: { ...packSnapshot(pack), ...(reason ? { reason } : {}) },
    ip: actor.ip,
  });
  return getPackageDetail(packageId);
}

/**
 * Undo a replacement. The pack that was live before comes back as a NEW
 * version (a copy, published), and the current one is superseded. Nothing is
 * overwritten, so the history shows exactly what was live and when.
 */
export async function rollbackPackage(packageId: string, actor: Actor): Promise<RatePackageDetail> {
  const current = await findPackageOr404(packageId);
  const previous =
    current.status === 'published' && current.supersedesId
      ? await RatePackageModel.findById(current.supersedesId)
      : null;
  if (!previous) {
    throw new HttpError(
      409,
      'nothing_to_roll_back',
      'Only a published pack that replaced an earlier one can be rolled back.',
    );
  }

  const clash = await RatePackageModel.find({
    supplierId: current.supplierId,
    status: 'published',
    _id: { $ne: current._id },
  });
  if (clash.some((other) => datesOverlap(previous, other))) {
    throw new HttpError(
      409,
      'rollback_overlaps',
      'The earlier version covers nights that another published pack now covers.',
    );
  }

  const [rates, visa] = await Promise.all([
    HotelRateModel.find({ packageId: previous._id }).lean(),
    VisaRateModel.findOne({ packageId: previous._id }).lean(),
  ]);

  const restoredId = await inTransaction(async () => {
    // Built as a draft and published last: a half-finished copy is never live.
    const restored = await RatePackageModel.create({
      supplierId: previous.supplierId,
      sourceDocumentId: previous.sourceDocumentId,
      packName: previous.packName,
      seasonLabel: previous.seasonLabel,
      nightFrom: previous.nightFrom,
      nightTo: previous.nightTo,
      effectiveFrom: previous.effectiveFrom,
      issueDate: previous.issueDate,
      currency: previous.currency,
      status: 'draft',
      version: current.version + 1,
      supersedesId: current._id,
      validation: previous.validation,
    });
    if (rates.length > 0) {
      await HotelRateModel.insertMany(
        rates.map(({ _id, createdAt, updatedAt, ...rate }) => ({
          ...rate,
          packageId: restored._id,
        })),
      );
    }
    if (visa) {
      const { _id, createdAt, updatedAt, ...fields } = visa;
      await VisaRateModel.create({ ...fields, packageId: restored._id });
    }

    assertTransition(RATE_PACKAGE_TRANSITIONS, 'published', 'superseded');
    current.status = 'superseded';
    await current.save();

    // A copy of reviewed, previously published data: it goes live without a
    // second review, which is the point of a rollback.
    restored.status = 'published';
    restored.publishedAt = new Date();
    restored.set('publishedBy', actor.id ?? null);
    await restored.save();
    await syncDocumentStatus(current.sourceDocumentId);
    await syncDocumentStatus(restored.sourceDocumentId);

    await recordAudit({
      actor,
      action: 'ratePackage.rollback',
      entityType: 'ratePackage',
      entityId: restored.id as string,
      before: { live: current.id as string, liveVersion: current.version },
      after: {
        ...packSnapshot(restored),
        restoredFrom: previous.id as string,
        restoredFromVersion: previous.version,
      },
      ip: actor.ip,
    });
    return restored.id as string;
  });
  return getPackageDetail(restoredId);
}
