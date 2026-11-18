/**
 * Staff dashboard (docs/01 section 6.2): new leads, quotes expiring in 48h,
 * rate packs expiring in 14 days, last published rate version.
 *
 * A section the signed-in role may not see is `null` (docs/02 section 3):
 * quotes for admin, sales and finance only; rate packs for admin and ops only.
 * No customer names or contact details: quotes are identified by the lead
 * reference.
 */
import type { RatePackageStatus } from '../status.js';

/** Sent quotes whose link stops working within this many hours. */
export const DASHBOARD_QUOTE_WINDOW_HOURS = 48;
/** Published packs whose last night falls within this many days (today included). */
export const DASHBOARD_PACK_WINDOW_DAYS = 14;
/** Rows listed under each count; the count itself is always the full total. */
export const DASHBOARD_LIST_LIMIT = 10;

export interface DashboardQuoteItem {
  quoteId: string;
  leadId: string;
  leadReference: string;
  version: number;
  /** ISO timestamp. */
  expiresAt: string;
}

export interface DashboardPackItem {
  packageId: string;
  packName: string;
  supplierName: string;
  version: number;
  /** Last night covered, "YYYY-MM-DD" (inclusive). */
  nightTo: string;
}

export interface DashboardPublishedPack {
  packageId: string;
  packName: string;
  supplierName: string;
  version: number;
  status: RatePackageStatus;
  /** ISO timestamp. */
  publishedAt: string;
}

export interface DashboardSummary {
  /** ISO timestamp of when the figures were read. */
  generatedAt: string;
  leads: { newCount: number };
  quotes: {
    windowHours: number;
    expiringCount: number;
    expiring: DashboardQuoteItem[];
  } | null;
  rates: {
    windowDays: number;
    expiringCount: number;
    expiring: DashboardPackItem[];
    lastPublished: DashboardPublishedPack | null;
  } | null;
}
