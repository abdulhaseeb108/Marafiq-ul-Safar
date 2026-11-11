import type {
  City,
  CreateHotelBody,
  HotelListQuery,
  HotelView,
  Paged,
  Transport,
  UpdateHotelBody,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import { HttpError, notFound } from '../../lib/http-error.js';
import { normalizeName, normalizedSet } from '../../lib/names.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { HotelModel, type HotelDoc } from './hotel.model.js';

export function toHotelView(doc: HotelDoc): HotelView {
  return {
    id: doc.id as string,
    city: doc.city as City,
    canonicalName: doc.canonicalName,
    aliases: [...doc.aliases],
    distanceMeters: doc.distanceMeters ?? null,
    distanceNote: doc.distanceNote ?? '',
    transport: doc.transport as Transport,
    starRating: doc.starRating ?? null,
    active: doc.active,
    mergedIntoId: doc.mergedIntoId ? String(doc.mergedIntoId) : null,
    createdAt: doc.createdAt,
  };
}

const snapshot = (doc: HotelDoc) => {
  const { id: _id, createdAt: _createdAt, ...rest } = toHotelView(doc);
  return rest;
};

async function findOr404(id: string): Promise<HotelDoc> {
  const doc = mongoose.isValidObjectId(id) ? await HotelModel.findById(id) : null;
  if (!doc) throw notFound('Hotel');
  return doc;
}

/**
 * Every name a hotel answers to must be unique within its city, so a name on a
 * rate sheet always resolves to one hotel. Throws naming the hotel that holds
 * the clashing name, so staff can merge the two instead of guessing.
 */
async function assertNamesFree(
  city: City,
  names: readonly string[],
  exceptId?: mongoose.Types.ObjectId,
): Promise<string[]> {
  const search = normalizedSet(names);
  if (search.length !== names.length) {
    const repeated = names.find((name, index) =>
      normalizedSet(names.slice(0, index)).includes(normalizeName(name)),
    );
    throw new HttpError(
      409,
      'name_in_use',
      `"${repeated ?? ''}" is listed twice for this hotel. Each name may appear once.`,
    );
  }
  const clash = await HotelModel.findOne({
    city,
    searchNames: { $in: search },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  if (clash) {
    throw new HttpError(
      409,
      'name_in_use',
      `Another hotel in this city already uses that name: "${clash.canonicalName}". Merge the two instead.`,
    );
  }
  return search;
}

export async function createHotel(body: CreateHotelBody, actor: Actor): Promise<HotelView> {
  const names = [body.canonicalName, ...body.aliases];
  const searchNames = await assertNamesFree(body.city, names);
  const doc = await HotelModel.create({
    city: body.city,
    canonicalName: body.canonicalName,
    aliases: body.aliases,
    searchNames,
    distanceMeters: body.distanceMeters ?? undefined,
    distanceNote: body.distanceNote,
    transport: body.transport,
    starRating: body.starRating ?? undefined,
    active: true,
  });
  await recordAudit({
    actor,
    action: 'hotel.create',
    entityType: 'hotel',
    entityId: doc.id as string,
    after: snapshot(doc),
    ip: actor.ip,
  });
  return toHotelView(doc);
}

export async function listHotels(query: HotelListQuery): Promise<Paged<HotelView>> {
  const filter: Record<string, unknown> = {};
  if (query.city) filter.city = query.city;
  if (!query.includeInactive) filter.active = true;

  const [docs, total] = await Promise.all([
    HotelModel.find(filter)
      .sort({ city: 1, canonicalName: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    HotelModel.countDocuments(filter),
  ]);
  return { items: docs.map(toHotelView), page: query.page, limit: query.limit, total };
}

export async function getHotel(id: string): Promise<HotelView> {
  return toHotelView(await findOr404(id));
}

/** Resolve a name printed on a rate sheet. Merged-away hotels never match. */
export async function findHotelByName(city: City, name: string): Promise<HotelView | null> {
  const doc = await HotelModel.findOne({ city, searchNames: normalizeName(name) });
  return doc ? toHotelView(doc) : null;
}

export async function updateHotel(
  id: string,
  body: UpdateHotelBody,
  actor: Actor,
): Promise<HotelView> {
  const doc = await findOr404(id);
  const before = snapshot(doc);

  const city = body.city ?? doc.city;
  const canonicalName = body.canonicalName ?? doc.canonicalName;
  const aliases = body.aliases ?? [...doc.aliases];
  if (body.city !== undefined || body.canonicalName !== undefined || body.aliases !== undefined) {
    doc.searchNames = await assertNamesFree(city, [canonicalName, ...aliases], doc._id);
    doc.city = city;
    doc.canonicalName = canonicalName;
    doc.aliases = aliases;
  }
  if (body.distanceMeters !== undefined) {
    doc.distanceMeters = body.distanceMeters ?? undefined;
  }
  if (body.distanceNote !== undefined) doc.distanceNote = body.distanceNote;
  if (body.transport !== undefined) doc.transport = body.transport;
  if (body.starRating !== undefined) doc.starRating = body.starRating ?? undefined;
  if (body.active !== undefined) doc.active = body.active;
  await doc.save();

  let action = 'hotel.update';
  if (body.active !== undefined && body.active !== before.active) {
    action = body.active ? 'hotel.reactivate' : 'hotel.deactivate';
  }
  await recordAudit({
    actor,
    action,
    entityType: 'hotel',
    entityId: doc.id as string,
    before,
    after: snapshot(doc),
    ip: actor.ip,
  });
  return toHotelView(doc);
}

export function deactivateHotel(id: string, actor: Actor): Promise<HotelView> {
  return updateHotel(id, { active: false }, actor);
}

/**
 * Fold `duplicateId` into `targetId`: the duplicate's names become aliases of
 * the target, and the duplicate is deactivated but kept for history.
 *
 * Done in two steps rather than a transaction, so it also works on a
 * standalone MongoDB. The duplicate releases its names first; if the second
 * step failed, the target would simply not have gained them yet and the merge
 * can be run again. Nothing is deleted at any point.
 *
 * Phase 3 adds hotelRates: repoint `hotelRates.hotelId` here as well.
 */
export async function mergeHotels(
  duplicateId: string,
  targetId: string,
  actor: Actor,
): Promise<HotelView> {
  const duplicate = await findOr404(duplicateId);
  if (duplicateId === targetId) {
    throw new HttpError(400, 'cannot_merge_into_self', 'Choose a different hotel to merge into');
  }
  const target = await findOr404(targetId);

  if (duplicate.city !== target.city) {
    throw new HttpError(
      400,
      'different_city',
      'Hotels can only be merged within the same city. Correct the city first if one of them is wrong.',
    );
  }
  for (const doc of [duplicate, target]) {
    if (doc.mergedIntoId) {
      throw new HttpError(
        400,
        'already_merged',
        `"${doc.canonicalName}" has already been merged into another hotel.`,
      );
    }
  }

  const duplicateBefore = snapshot(duplicate);
  const targetBefore = snapshot(target);
  const movedNames = [duplicate.canonicalName, ...duplicate.aliases];

  // 1. Release the duplicate's names so the target can take them.
  duplicate.searchNames = [];
  duplicate.active = false;
  duplicate.mergedIntoId = target._id;
  await duplicate.save();

  // 2. Give them to the target, keeping the order and dropping repeats.
  const seen = new Set(target.searchNames);
  for (const name of movedNames) {
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    target.aliases.push(name);
    target.searchNames.push(key);
  }
  await target.save();

  const detail = { mergedFrom: duplicate.canonicalName, mergedInto: target.canonicalName };
  await Promise.all([
    recordAudit({
      actor,
      action: 'hotel.merge',
      entityType: 'hotel',
      entityId: duplicate.id as string,
      before: duplicateBefore,
      after: { ...snapshot(duplicate), ...detail },
      ip: actor.ip,
    }),
    recordAudit({
      actor,
      action: 'hotel.merge',
      entityType: 'hotel',
      entityId: target.id as string,
      before: targetBefore,
      after: { ...snapshot(target), ...detail },
      ip: actor.ip,
    }),
  ]);
  return toHotelView(target);
}
