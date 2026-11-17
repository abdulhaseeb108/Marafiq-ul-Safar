/**
 * Staff dashboard figures (docs/01 section 6.2), read straight from the
 * database on every request; nothing is cached or estimated.
 *
 * - New leads: leads whose status is `new`.
 * - Quotes expiring soon: `sent` quotes whose link stops working within 48
 *   hours. Quotes expire lazily (quotes.service.ts): a sent quote past its
 *   expiry is still stored as `sent` until someone opens it, so the query also
 *   requires `expiresAt` to be in the future. Draft, accepted, declined,
 *   expired and replaced quotes never count.
 * - Rate packs expiring soon: `published` packs whose last night (`nightTo`,
 *   inclusive, a Pakistan date) is between today and today + 14 days.
 * - Last published rate version: the pack with the latest `publishedAt`
 *   (a rollback publishes a new version, so it counts as the latest).
 *
 * Sections follow the permission matrix (docs/02 section 3): quotes only for
 * roles that may read quotes (ops may not, decision 133); rate packs only for
 * roles that work with rate sheets. Customer names and contact details are
 * never included.
 */
import {
  DASHBOARD_LIST_LIMIT,
  DASHBOARD_PACK_WINDOW_DAYS,
  DASHBOARD_QUOTE_WINDOW_HOURS,
  type DashboardPackItem,
  type DashboardPublishedPack,
  type DashboardQuoteItem,
  type DashboardSummary,
  type RatePackageStatus,
  type Role,
} from '@marafiq/shared';
import type { Types } from 'mongoose';
import { LeadModel, QuoteModel } from '../leads/lead.models.js';
import { QUOTE_READERS } from '../leads/leads.service.js';
import { addDays } from '../pricing/engine.js';
import { todayInPakistan } from '../pricing/pricing.service.js';
import { RatePackageModel } from '../rate-sheets/rate-sheet.models.js';
import { RATE_SHEET_ROLES } from '../rate-sheets/rate-sheets.routes.js';
import { SupplierModel } from '../suppliers/supplier.model.js';

const HOUR_MS = 3_600_000;
const id = (value: unknown) => String(value);

async function supplierNames(ids: Types.ObjectId[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const suppliers = await SupplierModel.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  return new Map(suppliers.map((s) => [id(s._id), s.name]));
}

async function newLeadCount(): Promise<number> {
  return LeadModel.countDocuments({ status: 'new' });
}

async function expiringQuotes(now: Date): Promise<NonNullable<DashboardSummary['quotes']>> {
  const filter = {
    status: 'sent' as const,
    expiresAt: { $gt: now, $lte: new Date(now.getTime() + DASHBOARD_QUOTE_WINDOW_HOURS * HOUR_MS) },
  };
  const [expiringCount, quotes] = await Promise.all([
    QuoteModel.countDocuments(filter),
    QuoteModel.find(filter)
      .sort({ expiresAt: 1, _id: 1 })
      .limit(DASHBOARD_LIST_LIMIT)
      .select('leadId version expiresAt')
      .lean(),
  ]);
  const leads = await LeadModel.find({ _id: { $in: quotes.map((q) => q.leadId) } })
    .select('reference')
    .lean();
  const references = new Map(leads.map((l) => [id(l._id), l.reference]));
  const expiring: DashboardQuoteItem[] = quotes.map((q) => ({
    quoteId: id(q._id),
    leadId: id(q.leadId),
    leadReference: references.get(id(q.leadId)) ?? '',
    version: q.version,
    expiresAt: q.expiresAt.toISOString(),
  }));
  return { windowHours: DASHBOARD_QUOTE_WINDOW_HOURS, expiringCount, expiring };
}

async function rateFigures(now: Date): Promise<NonNullable<DashboardSummary['rates']>> {
  const today = todayInPakistan(now);
  // "YYYY-MM-DD" strings compare in date order.
  const filter = {
    status: 'published' as const,
    nightTo: { $ne: null, $gte: today, $lte: addDays(today, DASHBOARD_PACK_WINDOW_DAYS) },
  };
  const [expiringCount, packs, latest] = await Promise.all([
    RatePackageModel.countDocuments(filter),
    RatePackageModel.find(filter)
      .sort({ nightTo: 1, _id: 1 })
      .limit(DASHBOARD_LIST_LIMIT)
      .select('supplierId packName version nightTo')
      .lean(),
    RatePackageModel.findOne({ publishedAt: { $ne: null } })
      .sort({ publishedAt: -1, _id: -1 })
      .select('supplierId packName version status publishedAt')
      .lean(),
  ]);
  const names = await supplierNames([
    ...packs.map((p) => p.supplierId),
    ...(latest ? [latest.supplierId] : []),
  ]);
  const expiring: DashboardPackItem[] = packs.map((p) => ({
    packageId: id(p._id),
    packName: p.packName,
    supplierName: names.get(id(p.supplierId)) ?? '',
    version: p.version,
    nightTo: p.nightTo as string,
  }));
  const lastPublished: DashboardPublishedPack | null =
    latest && latest.publishedAt
      ? {
          packageId: id(latest._id),
          packName: latest.packName,
          supplierName: names.get(id(latest.supplierId)) ?? '',
          version: latest.version,
          status: latest.status as RatePackageStatus,
          publishedAt: latest.publishedAt.toISOString(),
        }
      : null;
  return { windowDays: DASHBOARD_PACK_WINDOW_DAYS, expiringCount, expiring, lastPublished };
}

/** The dashboard for one signed-in staff role. */
export async function getDashboard(role: Role, now: Date = new Date()): Promise<DashboardSummary> {
  const canSeeQuotes = QUOTE_READERS.includes(role);
  const canSeeRates = (RATE_SHEET_ROLES as readonly Role[]).includes(role);
  const [newCount, quotes, rates] = await Promise.all([
    newLeadCount(),
    canSeeQuotes ? expiringQuotes(now) : Promise.resolve(null),
    canSeeRates ? rateFigures(now) : Promise.resolve(null),
  ]);
  return { generatedAt: now.toISOString(), leads: { newCount }, quotes, rates };
}
