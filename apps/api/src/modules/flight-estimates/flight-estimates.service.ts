import type {
  CreateFlightEstimateBody,
  Destination,
  FlightEstimateView,
  ListQuery,
  Paged,
  UpdateFlightEstimateBody,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import { HttpError, notFound } from '../../lib/http-error.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { FlightEstimateModel, type FlightEstimateDoc } from './flight-estimate.model.js';

/** Today as "YYYY-MM-DD" in UTC, to compare with stored validTo dates. */
export function today(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export function toFlightEstimateView(
  doc: FlightEstimateDoc,
  at: Date = new Date(),
): FlightEstimateView {
  return {
    id: doc.id as string,
    originCity: doc.originCity,
    destination: doc.destination as Destination,
    season: doc.season ?? null,
    lowMinor: doc.lowMinor,
    highMinor: doc.highMinor,
    currency: 'PKR',
    validTo: doc.validTo,
    note: doc.note ?? null,
    source: doc.source,
    expired: doc.validTo < today(at),
    createdAt: doc.createdAt,
  };
}

const snapshot = (doc: FlightEstimateDoc) => {
  const { id: _id, createdAt: _createdAt, expired: _expired, ...rest } = toFlightEstimateView(doc);
  return rest;
};

async function findOr404(id: string): Promise<FlightEstimateDoc> {
  const doc = mongoose.isValidObjectId(id) ? await FlightEstimateModel.findById(id) : null;
  if (!doc) throw notFound('Flight estimate');
  return doc;
}

/** Checked against the stored values too, not only the fields in this request. */
function assertRangeValid(lowMinor: number, highMinor: number): void {
  if (highMinor < lowMinor) {
    throw new HttpError(400, 'validation_error', 'Please check the highlighted fields', {
      highMinor: 'The high estimate cannot be below the low estimate',
    });
  }
}

export async function createFlightEstimate(
  body: CreateFlightEstimateBody,
  actor: Actor,
): Promise<FlightEstimateView> {
  const doc = await FlightEstimateModel.create({
    originCity: body.originCity,
    destination: body.destination,
    season: body.season || undefined,
    lowMinor: body.lowMinor,
    highMinor: body.highMinor,
    currency: 'PKR',
    validTo: body.validTo,
    note: body.note || undefined,
    source: body.source,
  });
  await recordAudit({
    actor,
    action: 'flightEstimate.create',
    entityType: 'flightEstimate',
    entityId: doc.id as string,
    after: snapshot(doc),
    ip: actor.ip,
  });
  return toFlightEstimateView(doc);
}

export async function listFlightEstimates(query: ListQuery): Promise<Paged<FlightEstimateView>> {
  const [docs, total] = await Promise.all([
    FlightEstimateModel.find()
      .sort({ originCity: 1, destination: 1, validTo: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FlightEstimateModel.countDocuments(),
  ]);
  return {
    items: docs.map((doc) => toFlightEstimateView(doc)),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getFlightEstimate(id: string): Promise<FlightEstimateView> {
  return toFlightEstimateView(await findOr404(id));
}

export async function updateFlightEstimate(
  id: string,
  body: UpdateFlightEstimateBody,
  actor: Actor,
): Promise<FlightEstimateView> {
  const doc = await findOr404(id);
  const before = snapshot(doc);

  assertRangeValid(body.lowMinor ?? doc.lowMinor, body.highMinor ?? doc.highMinor);

  if (body.originCity !== undefined) doc.originCity = body.originCity;
  if (body.destination !== undefined) doc.destination = body.destination;
  if (body.season !== undefined) doc.season = body.season === '' ? undefined : body.season;
  if (body.lowMinor !== undefined) doc.lowMinor = body.lowMinor;
  if (body.highMinor !== undefined) doc.highMinor = body.highMinor;
  if (body.validTo !== undefined) doc.validTo = body.validTo;
  if (body.note !== undefined) doc.note = body.note === '' ? undefined : body.note;
  if (body.source !== undefined) doc.source = body.source;
  await doc.save();

  await recordAudit({
    actor,
    action: 'flightEstimate.update',
    entityType: 'flightEstimate',
    entityId: doc.id as string,
    before,
    after: snapshot(doc),
    ip: actor.ip,
  });
  return toFlightEstimateView(doc);
}

/**
 * Departure cities a traveler may pick: those with an estimate that has not
 * expired. Expired rows stay in the database for history (docs/05 #13).
 */
export async function activeDepartureCities(at: Date = new Date()): Promise<string[]> {
  const cities = await FlightEstimateModel.distinct('originCity', {
    validTo: { $gte: today(at) },
  });
  return cities.sort((a, b) => a.localeCompare(b));
}
