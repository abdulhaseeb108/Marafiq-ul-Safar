/**
 * Request bodies and response shapes for master data (Phase 2):
 * suppliers, hotels, settings, FX rates and flight estimates.
 */
import { z } from 'zod';
import { LANGUAGES } from '../status.js';
import { citySchema } from './collections.js';
import { fxRateString, isoDate, objectId, positiveMinor, timestamp } from './common.js';

const trimmed = (max: number) => z.string().trim().min(1).max(max);
/** Optional free text; "" clears the field. */
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const supplierTypeSchema = z.enum([
  'hotel_operator',
  'transport',
  'flight_partner',
  'other',
]);
export const transportSchema = z.enum(['walking', 'shuttle', 'unknown']);
export const destinationSchema = z.enum(['JED', 'MED']);

// --- suppliers ------------------------------------------------------------
export const CreateSupplierBodySchema = z.object({
  name: trimmed(160),
  type: supplierTypeSchema,
  contactName: optionalText(120),
  phone: optionalText(40),
  email: z.union([z.literal(''), z.email()]).optional(),
  notes: optionalText(2000),
});

export const UpdateSupplierBodySchema = CreateSupplierBodySchema.partial()
  .extend({ active: z.boolean().optional() })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });

export const SupplierViewSchema = z.object({
  id: objectId,
  name: z.string(),
  type: supplierTypeSchema,
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  createdAt: timestamp,
});

// --- hotels ---------------------------------------------------------------
/** Up to 20 aliases, each trimmed and non-empty. */
const aliasList = z.array(trimmed(160)).max(20);

export const CreateHotelBodySchema = z.object({
  city: citySchema,
  canonicalName: trimmed(160),
  aliases: aliasList.default([]),
  distanceMeters: z.number().int().min(0).max(100_000).nullish(),
  distanceNote: z.string().trim().max(300).default(''),
  transport: transportSchema.default('unknown'),
  /** Only when the supplier states it. */
  starRating: z.number().int().min(1).max(5).nullish(),
});

export const UpdateHotelBodySchema = z
  .object({
    city: citySchema.optional(),
    canonicalName: trimmed(160).optional(),
    aliases: aliasList.optional(),
    distanceMeters: z.number().int().min(0).max(100_000).nullish(),
    distanceNote: z.string().trim().max(300).optional(),
    transport: transportSchema.optional(),
    starRating: z.number().int().min(1).max(5).nullish(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const MergeHotelBodySchema = z.object({
  /** The hotel to keep. The one in the URL is folded into it. */
  targetId: objectId,
});

export const HotelViewSchema = z.object({
  id: objectId,
  city: citySchema,
  canonicalName: z.string(),
  aliases: z.array(z.string()),
  distanceMeters: z.number().nullable(),
  distanceNote: z.string(),
  transport: transportSchema,
  starRating: z.number().nullable(),
  active: z.boolean(),
  mergedIntoId: objectId.nullable(),
  createdAt: timestamp,
});

export const HotelListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  city: citySchema.optional(),
  /** Default false: merged and deactivated hotels are hidden. */
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
});

// --- settings -------------------------------------------------------------
export const UpdateSettingsBodySchema = z
  .object({
    markupPercent: z.number().min(0).max(100).optional(),
    estimateExpiryHours: z.number().int().min(1).max(720).optional(),
    responseTimeText: trimmed(200).optional(),
    infantHotelCharge: z.enum(['none']).optional(),
    childAsAdult: z.boolean().optional(),
    showSupplierRates: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const SettingsViewSchema = z.object({
  markupPercent: z.number(),
  estimateExpiryHours: z.number(),
  responseTimeText: z.string(),
  infantHotelCharge: z.literal('none'),
  childAsAdult: z.boolean(),
  showSupplierRates: z.boolean(),
  updatedAt: timestamp,
});

// --- FX rates -------------------------------------------------------------
/** A change of more than this versus the previous rate needs confirmation. */
export const FX_LARGE_CHANGE_PERCENT = 30;

export const CreateFxBodySchema = z.object({
  rate: fxRateString,
  /** Defaults to now. A future date means it takes effect then. */
  effectiveAt: z.coerce.date().optional(),
  /** Required to accept a change of more than 30% versus the previous rate. */
  confirmLargeChange: z.boolean().default(false),
});

export const FxRateViewSchema = z.object({
  id: objectId,
  base: z.literal('SAR'),
  quote: z.literal('PKR'),
  rate: z.string(),
  effectiveAt: timestamp,
  setBy: objectId.nullable(),
  setByName: z.string().nullable(),
  createdAt: timestamp,
});

// --- flight estimates -----------------------------------------------------
export const CreateFlightEstimateBodySchema = z
  .object({
    originCity: trimmed(120),
    destination: destinationSchema,
    season: optionalText(80),
    lowMinor: positiveMinor,
    highMinor: positiveMinor,
    validTo: isoDate,
    note: optionalText(500),
    source: trimmed(300),
  })
  .refine((body) => body.highMinor >= body.lowMinor, {
    message: 'The high estimate cannot be below the low estimate',
    path: ['highMinor'],
  });

export const UpdateFlightEstimateBodySchema = z
  .object({
    originCity: trimmed(120).optional(),
    destination: destinationSchema.optional(),
    season: optionalText(80),
    lowMinor: positiveMinor.optional(),
    highMinor: positiveMinor.optional(),
    validTo: isoDate.optional(),
    note: optionalText(500),
    source: trimmed(300).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const FlightEstimateViewSchema = z.object({
  id: objectId,
  originCity: z.string(),
  destination: destinationSchema,
  season: z.string().nullable(),
  lowMinor: z.number(),
  highMinor: z.number(),
  currency: z.literal('PKR'),
  validTo: isoDate,
  note: z.string().nullable(),
  source: z.string(),
  /** Derived: validTo is in the past. Expired rows stay but are not offered. */
  expired: z.boolean(),
  createdAt: timestamp,
});

// --- public config --------------------------------------------------------
/**
 * GET /public/config. Deliberately narrow: no supplier contacts, no internal
 * notes, and the markup is a flag only, never the percentage.
 */
export const PublicConfigSchema = z.object({
  languages: z.array(z.enum(LANGUAGES)),
  fx: z.object({ rate: z.string(), effectiveAt: timestamp }).nullable(),
  markupApplied: z.boolean(),
  showSupplierRates: z.boolean(),
  responseTimeText: z.string(),
  /** Cities with a flight estimate that has not expired. */
  departureCities: z.array(z.string()),
});

export type CreateSupplierBody = z.infer<typeof CreateSupplierBodySchema>;
export type UpdateSupplierBody = z.infer<typeof UpdateSupplierBodySchema>;
export type SupplierView = z.infer<typeof SupplierViewSchema>;
export type CreateHotelBody = z.infer<typeof CreateHotelBodySchema>;
export type UpdateHotelBody = z.infer<typeof UpdateHotelBodySchema>;
export type MergeHotelBody = z.infer<typeof MergeHotelBodySchema>;
export type HotelView = z.infer<typeof HotelViewSchema>;
export type HotelListQuery = z.infer<typeof HotelListQuerySchema>;
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBodySchema>;
export type SettingsView = z.infer<typeof SettingsViewSchema>;
export type CreateFxBody = z.infer<typeof CreateFxBodySchema>;
export type FxRateView = z.infer<typeof FxRateViewSchema>;
export type CreateFlightEstimateBody = z.infer<typeof CreateFlightEstimateBodySchema>;
export type UpdateFlightEstimateBody = z.infer<typeof UpdateFlightEstimateBodySchema>;
export type FlightEstimateView = z.infer<typeof FlightEstimateViewSchema>;
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
export type SupplierType = z.infer<typeof supplierTypeSchema>;
export type Transport = z.infer<typeof transportSchema>;
export type Destination = z.infer<typeof destinationSchema>;
