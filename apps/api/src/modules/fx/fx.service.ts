import {
  FX_LARGE_CHANGE_PERCENT,
  parseFxRate,
  type CreateFxBody,
  type FxRateView,
  type ListQuery,
  type Paged,
} from '@marafiq/shared';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { UserModel } from '../users/user.model.js';
import { FxRateModel, type FxRateDoc } from './fx.model.js';

/** Newest first; `_id` breaks ties when two rows share an effective date. */
const NEWEST_FIRST = { effectiveAt: -1 as const, _id: -1 as const };

function toView(doc: FxRateDoc, setByName: string | null = null): FxRateView {
  return {
    id: doc.id as string,
    base: 'SAR',
    quote: 'PKR',
    rate: doc.rate,
    effectiveAt: doc.effectiveAt,
    setBy: doc.setBy ? String(doc.setBy) : null,
    setByName,
    createdAt: doc.createdAt,
  };
}

async function withNames(docs: FxRateDoc[]): Promise<FxRateView[]> {
  const ids = [...new Set(docs.map((doc) => doc.setBy).filter(Boolean))];
  const users = await UserModel.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  const names = new Map(users.map((user) => [String(user._id), user.name]));
  return docs.map((doc) => toView(doc, doc.setBy ? (names.get(String(doc.setBy)) ?? null) : null));
}

/**
 * The rate in force at `at`. Future-dated rows are ignored until their time
 * comes; returns null when no rate had been set yet.
 */
export async function getCurrentFx(at: Date = new Date()): Promise<FxRateView | null> {
  const doc = await FxRateModel.findOne({ effectiveAt: { $lte: at } }).sort(NEWEST_FIRST);
  return doc ? toView(doc) : null;
}

/** The newest row by effective date, future-dated ones included. */
function latestFx(): Promise<FxRateDoc | null> {
  return FxRateModel.findOne().sort(NEWEST_FIRST);
}

/** True when `rate` differs from `previous` by more than 30%. */
export function isLargeChange(previous: string, rate: string): boolean {
  const previousScaled = parseFxRate(previous);
  const nextScaled = parseFxRate(rate);
  const difference = Math.abs(nextScaled - previousScaled);
  // difference / previous > 30 / 100, without floating point.
  return difference * 100 > previousScaled * FX_LARGE_CHANGE_PERCENT;
}

export async function createFxRate(body: CreateFxBody, actor: Actor): Promise<FxRateView> {
  const previous = await latestFx();
  if (previous && !body.confirmLargeChange && isLargeChange(previous.rate, body.rate)) {
    throw new HttpError(
      409,
      'large_fx_change',
      `${body.rate} differs from the current rate (${previous.rate}) by more than ${FX_LARGE_CHANGE_PERCENT}%. Check the figure, then confirm to save it.`,
    );
  }

  const doc = await FxRateModel.create({
    base: 'SAR',
    quote: 'PKR',
    rate: body.rate,
    effectiveAt: body.effectiveAt ?? new Date(),
    setBy: actor.id,
  });

  await recordAudit({
    actor,
    action: 'fx.create',
    entityType: 'fxRate',
    entityId: doc.id as string,
    before: previous ? { rate: previous.rate, effectiveAt: previous.effectiveAt } : undefined,
    after: {
      rate: doc.rate,
      effectiveAt: doc.effectiveAt,
      confirmedLargeChange: body.confirmLargeChange || undefined,
    },
    ip: actor.ip,
  });
  const [view] = await withNames([doc]);
  return view as FxRateView;
}

export async function listFxRates(query: ListQuery): Promise<Paged<FxRateView>> {
  const [docs, total] = await Promise.all([
    FxRateModel.find()
      .sort(NEWEST_FIRST)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    FxRateModel.countDocuments(),
  ]);
  return { items: await withNames(docs), page: query.page, limit: query.limit, total };
}
