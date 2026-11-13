/**
 * Rate sheet ingestion (Phase 3): what the extraction model must return, the
 * request bodies of the review screen, and the shapes the admin API returns.
 */
import { z } from 'zod';
import type { ExtractionStatus, RatePackageStatus } from '../status.js';
import { RATE_PACKAGE_STATUSES } from '../status.js';
import { citySchema, pricingModeSchema } from './collections.js';
import { isoDate, objectId } from './common.js';

// --- extraction result ------------------------------------------------------
/** SAR amount as printed, up to two decimal places, or null when empty or unreadable. */
const printedAmount = z.number().finite().nullish();

export const ExtractedHotelRowSchema = z.object({
  city: citySchema,
  /** Exactly as printed. */
  name: z.string().trim().min(1).max(200),
  aliasesPrinted: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  distanceText: z.string().trim().max(300).nullish(),
  distanceMeters: z.number().finite().nullish(),
  transportText: z.string().trim().max(300).nullish(),
  pricingMode: pricingModeSchema,
  /** The ROOM column (per room, per night). */
  room: printedAmount,
  perPerson: z
    .object({
      quint: printedAmount,
      quad: printedAmount,
      triple: printedAmount,
      double: printedAmount,
    })
    .default({}),
  flatNote: z.string().trim().max(600).nullish(),
  page: z.number().int().min(1).default(1),
  row: z.number().int().min(0).default(0),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const ExtractedPackSchema = z.object({
  supplierName: z.string().nullish(),
  packName: z.string().trim().min(1).max(120),
  seasonLabel: z.string().trim().max(120).nullish(),
  /** Null when the model could not read it; that blocks publishing. */
  nightFrom: isoDate.nullable(),
  nightTo: isoDate.nullable(),
  effectiveFrom: isoDate.nullish(),
  issueDate: isoDate.nullish(),
  /** Not restricted here: a non-SAR sheet must be flagged, not thrown away. */
  currency: z.string().trim().min(1).max(10),
  visa: z.object({
    directPerPerson: printedAmount,
    indirectByGroupSize: z
      .object({ '1': printedAmount, '2': printedAmount, '3': printedAmount, '4': printedAmount })
      .default({}),
    infant: printedAmount,
    notes: z.string().trim().max(600).nullish(),
  }),
  hotels: z.array(ExtractedHotelRowSchema).max(200),
  warnings: z.array(z.string()).default([]),
});

/**
 * One uploaded file often holds several packs (the WMT PDF has three, one per
 * page), so the model returns a list. docs/03 section 3 describes one entry.
 */
export const ExtractionResultSchema = z.object({
  packs: z.array(ExtractedPackSchema).min(1).max(12),
});

export type ExtractedHotelRow = z.infer<typeof ExtractedHotelRowSchema>;
export type ExtractedPack = z.infer<typeof ExtractedPackSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// --- review screen request bodies ------------------------------------------
/** Halalas. Zero is storable so staff can see it; validation then blocks it. */
const editableMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

export const UpdateRatePackageBodySchema = z
  .object({
    packName: z.string().trim().min(1).max(120).optional(),
    seasonLabel: z.string().trim().max(120).nullable().optional(),
    nightFrom: isoDate.nullable().optional(),
    nightTo: isoDate.nullable().optional(),
    effectiveFrom: isoDate.nullable().optional(),
    issueDate: isoDate.nullable().optional(),
    /** The published pack this one replaces, or null for none. */
    supersedesId: objectId.nullable().optional(),
    visa: z
      .object({
        directPerPersonMinor: editableMinor.optional(),
        indirectByGroupSizeMinor: z
          .object({
            '1': editableMinor.optional(),
            '2': editableMinor.optional(),
            '3': editableMinor.optional(),
            '4': editableMinor.optional(),
          })
          .optional(),
        infantMinor: editableMinor.optional(),
        appliesNote: z.string().trim().max(600).nullable().optional(),
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

const perPersonEdit = z.object({
  quint: editableMinor.optional(),
  quad: editableMinor.optional(),
  triple: editableMinor.optional(),
  double: editableMinor.optional(),
});

export const UpdateHotelRateBodySchema = z
  .object({
    pricingMode: pricingModeSchema.optional(),
    roomPriceMinor: editableMinor.optional(),
    perPersonMinor: perPersonEdit.optional(),
    flatNote: z.string().trim().max(600).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

/** Add a row by hand, for a hotel the extraction missed. */
export const AddHotelRateBodySchema = z.object({
  hotelId: objectId,
  pricingMode: pricingModeSchema,
  roomPriceMinor: editableMinor.default(null),
  perPersonMinor: perPersonEdit.default({}),
  flatNote: z.string().trim().max(600).nullable().default(null),
});

/** Resolve a name the system did not recognise. */
export const ConfirmHotelBodySchema = z.discriminatedUnion('action', [
  /** It is a new hotel: create it from what the sheet prints. */
  z.object({ action: z.literal('create') }),
  /** It is an existing hotel under another name: remember the name as an alias. */
  z.object({ action: z.literal('map'), hotelId: objectId }),
]);

export const PublishBodySchema = z.object({
  /** Required when the pack has warnings: staff confirm they have read them. */
  acknowledgeWarnings: z.boolean().default(false),
});

export const RejectBodySchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const RatePackageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(RATE_PACKAGE_STATUSES).optional(),
  supplierId: objectId.optional(),
});

export type UpdateRatePackageBody = z.infer<typeof UpdateRatePackageBodySchema>;
export type UpdateHotelRateBody = z.infer<typeof UpdateHotelRateBodySchema>;
export type AddHotelRateBody = z.infer<typeof AddHotelRateBodySchema>;
export type ConfirmHotelBody = z.infer<typeof ConfirmHotelBodySchema>;
export type PublishBody = z.infer<typeof PublishBodySchema>;
export type RejectBody = z.infer<typeof RejectBodySchema>;
export type RatePackageListQuery = z.infer<typeof RatePackageListQuerySchema>;

// --- admin API responses ----------------------------------------------------
export type PricingMode = z.infer<typeof pricingModeSchema>;

export interface ValidationIssue {
  /** Stable machine code, e.g. "derived_mismatch". */
  code: string;
  message: string;
  /** What it points at, e.g. "rate:<hotelRateId>" or "visa" or "header". */
  path?: string;
}

export interface PackageValidation {
  blocking: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface PerPersonMinor {
  quint: number | null;
  quad: number | null;
  triple: number | null;
  double: number | null;
}

export interface HotelRateView {
  id: string;
  packageId: string;
  /** Null until staff confirm which hotel the printed name means. */
  hotelId: string | null;
  hotelName: string | null;
  printed: {
    city: 'makkah' | 'madinah';
    name: string;
    aliases: string[];
    distanceText: string | null;
    distanceMeters: number | null;
    transportText: string | null;
  };
  /** A close match offered to staff. Never applied automatically. */
  suggestedHotelId: string | null;
  suggestedHotelName: string | null;
  pricingMode: PricingMode;
  roomPriceMinor: number | null;
  perPersonMinor: PerPersonMinor;
  flatNote: string | null;
  sourcePage: number;
  sourceRow: number;
  confidence: number;
  /** True once a staff user changed the extracted values. */
  edited: boolean;
}

export interface VisaRateView {
  directPerPersonMinor: number | null;
  indirectByGroupSizeMinor: {
    '1': number | null;
    '2': number | null;
    '3': number | null;
    '4': number | null;
  };
  infantMinor: number | null;
  /** Staff only until confirmed with the supplier. */
  appliesNote: string | null;
}

export interface RatePackageSummary {
  id: string;
  supplierId: string;
  sourceDocumentId: string;
  packName: string;
  seasonLabel: string | null;
  nightFrom: string | null;
  nightTo: string | null;
  issueDate: string | null;
  status: RatePackageStatus;
  version: number;
  blockingCount: number;
  warningCount: number;
  publishedAt: Date | null;
}

export interface RatePackageDetail extends RatePackageSummary {
  supplierName: string;
  effectiveFrom: string | null;
  currency: string;
  supersedesId: string | null;
  publishedByName: string | null;
  validation: PackageValidation;
  visa: VisaRateView;
  rates: HotelRateView[];
  /** Published packs this one could be marked as replacing. */
  replaceable: { id: string; packName: string; nightFrom: string | null; nightTo: string | null }[];
  canRollback: boolean;
}

export interface SourceDocumentView {
  id: string;
  supplierId: string;
  supplierName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  receivedAt: Date;
  uploadedByName: string | null;
  extractionStatus: ExtractionStatus;
  extractionModel: string | null;
  /** A plain message for staff. Raw model output is never returned by the API. */
  extractionError: string | null;
  notes: string | null;
  packages: RatePackageSummary[];
}

/** Upload limits, shared so the browser can check before sending. */
export const RATE_SHEET_MAX_BYTES = 20 * 1024 * 1024;
export const RATE_SHEET_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type RateSheetMimeType = (typeof RATE_SHEET_MIME_TYPES)[number];
