/**
 * Zod schemas for every collection in docs/02-DATA-MODEL-AND-API.md section 1.
 *
 * These describe stored documents. Unknown keys are stripped, so fields we must
 * never collect (passport, CNIC, card data) cannot pass through.
 *
 * Draft rate data may be incomplete: fields whose absence is a *blocking
 * validation error* in docs/03 section 4 are nullable here, because a draft
 * must be storable before staff fix it. Publish rules are enforced in Phase 3.
 */
import { z } from 'zod';
import {
  EXTRACTION_STATUSES,
  LANGUAGES,
  LEAD_STATUSES,
  QUOTE_STATUSES,
  RATE_PACKAGE_STATUSES,
  ROLES,
} from '../status.js';
import {
  baseDoc,
  currency,
  fxRateString,
  fxSnapshot,
  isoDate,
  minor,
  objectId,
  positiveMinor,
  timestamp,
} from './common.js';

export const roleSchema = z.enum(ROLES);
export const languageSchema = z.enum(LANGUAGES);
export const citySchema = z.enum(['makkah', 'madinah']);
export const pricingModeSchema = z.enum(['derived_per_person', 'flat_per_room', 'on_request']);

// users
export const UserSchema = z.object({
  ...baseDoc,
  email: z.email(),
  name: z.string().min(1),
  passwordHash: z.string().min(1),
  role: roleSchema,
  /** Active TOTP secret, AES-256-GCM encrypted. */
  totpSecretEnc: z.string().optional(),
  /** Secret generated during enrollment, not yet proven with a code. */
  totpPendingSecretEnc: z.string().optional(),
  active: z.boolean(),
  lastLoginAt: timestamp.nullish(),
});

// suppliers
export const SupplierSchema = z.object({
  ...baseDoc,
  name: z.string().min(1),
  type: z.enum(['hotel_operator', 'transport', 'flight_partner', 'other']),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.email().optional(),
  notes: z.string().optional(),
  active: z.boolean(),
});

// hotels
export const HotelSchema = z.object({
  ...baseDoc,
  city: citySchema,
  canonicalName: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  distanceMeters: z.number().int().nonnegative().optional(),
  distanceNote: z.string(),
  transport: z.enum(['walking', 'shuttle', 'unknown']),
  /** Only when the supplier states it. */
  starRating: z.number().int().min(1).max(5).optional(),
  active: z.boolean(),
});

// sourceDocuments
export const SourceDocumentSchema = z.object({
  ...baseDoc,
  supplierId: objectId,
  fileKey: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest'),
  receivedAt: timestamp,
  issueDate: isoDate.optional(),
  uploadedBy: objectId,
  extractionStatus: z.enum(EXTRACTION_STATUSES),
  extractionModel: z.string().optional(),
  /** Raw model output. Staff only; never sent to the public site. */
  extractionRaw: z.unknown().optional(),
  notes: z.string().optional(),
});

// ratePackages
export const validationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.string().optional(),
});

export const RatePackageSchema = z
  .object({
    ...baseDoc,
    supplierId: objectId,
    sourceDocumentId: objectId,
    packName: z.string().min(1),
    seasonLabel: z.string().nullish(),
    nightFrom: isoDate.nullable(),
    /** Inclusive. */
    nightTo: isoDate.nullable(),
    effectiveFrom: isoDate.nullish(),
    issueDate: isoDate.nullish(),
    currency: z.literal('SAR'),
    status: z.enum(RATE_PACKAGE_STATUSES),
    version: z.number().int().positive(),
    supersedesId: objectId.optional(),
    publishedAt: timestamp.optional(),
    publishedBy: objectId.optional(),
    validation: z.object({
      blocking: z.array(validationIssueSchema),
      warnings: z.array(validationIssueSchema),
    }),
  })
  .refine((p) => !p.nightFrom || !p.nightTo || p.nightTo >= p.nightFrom, {
    message: 'nightTo must not be before nightFrom',
    path: ['nightTo'],
  });

// hotelRates
export const perPersonMinorSchema = z.object({
  quint: positiveMinor.nullish(),
  quad: positiveMinor.nullish(),
  triple: positiveMinor.nullish(),
  double: positiveMinor.nullish(),
});

export const HotelRateSchema = z.object({
  ...baseDoc,
  packageId: objectId,
  hotelId: objectId,
  pricingMode: pricingModeSchema,
  /** Per room, per night. */
  roomPriceMinor: positiveMinor.nullish(),
  perPersonMinor: perPersonMinorSchema.optional(),
  flatNote: z.string().optional(),
  sourcePage: z.number().int().positive(),
  sourceRow: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  /** True once a staff user changed the extracted value. */
  edited: z.boolean(),
});

// visaRates
export const VisaRateSchema = z.object({
  ...baseDoc,
  packageId: objectId,
  direct: z.object({ perPersonMinor: positiveMinor.nullable() }),
  indirectByGroupSize: z.object({
    '1': positiveMinor.nullable(),
    '2': positiveMinor.nullable(),
    '3': positiveMinor.nullable(),
    '4': positiveMinor.nullable(),
  }),
  infantMinor: positiveMinor.nullable(),
  /** Shown to staff only until confirmed with the supplier. */
  appliesNote: z.string().optional(),
});

// fxRates
export const FxRateSchema = z.object({
  ...baseDoc,
  base: z.literal('SAR'),
  quote: z.literal('PKR'),
  rate: fxRateString,
  effectiveAt: timestamp,
  setBy: objectId,
});

// settings (single document)
export const SettingsSchema = z.object({
  ...baseDoc,
  markupPercent: z.number().min(0).max(100).default(0),
  estimateExpiryHours: z.number().int().positive().default(72),
  responseTimeText: z.string().default('within 1 business day'),
  infantHotelCharge: z.enum(['none']).default('none'),
  childAsAdult: z.boolean().default(true),
  /** docs/05 #18: false shows "From PKR X" instead of supplier rates. */
  showSupplierRates: z.boolean().default(true),
});

// flightEstimates
export const FlightEstimateSchema = z
  .object({
    ...baseDoc,
    originCity: z.string().min(1),
    destination: z.enum(['JED', 'MED']),
    season: z.string().optional(),
    lowMinor: positiveMinor,
    highMinor: positiveMinor,
    currency: z.literal('PKR'),
    validTo: isoDate,
    note: z.string().optional(),
    source: z.string().min(1),
  })
  .refine((f) => f.highMinor >= f.lowMinor, {
    message: 'highMinor must not be below lowMinor',
    path: ['highMinor'],
  });

// calculations (immutable snapshot)
export const CalculationSchema = z.object({
  ...baseDoc,
  /** Calculator inputs. Tightened in Phase 4 with the pricing engine. */
  inputs: z.record(z.string(), z.unknown()),
  rateVersionSnapshot: z.array(
    z.object({
      packageId: objectId,
      version: z.number().int().positive(),
      supplierId: objectId,
      issueDate: isoDate.nullable(),
    }),
  ),
  fx: fxSnapshot,
  markupPercent: z.number().min(0).max(100),
  /** Line-item shape is defined in Phase 4 with the pricing engine. */
  lineItems: z.array(z.record(z.string(), z.unknown())),
  missing: z.array(z.string()),
  assumptions: z.array(z.string()),
  exclusions: z.array(z.string()),
  totals: z.object({
    perPersonMinorPKR: minor,
    groupMinorPKR: minor,
    groupMinorSAR: minor,
    isPartial: z.boolean(),
  }),
  expiresAt: timestamp,
  hash: z.string().min(1),
  engineVersion: z.string().min(1),
});

// travelers — contact details only; no passport, CNIC or card data
export const TravelerSchema = z.object({
  ...baseDoc,
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.email().optional(),
  language: languageSchema,
});

// leads
export const LeadSchema = z.object({
  ...baseDoc,
  reference: z.string().regex(/^MSF-\d{4}-\d{6}$/, 'Expected MSF-YYYY-NNNNNN'),
  travelerId: objectId,
  calculationId: objectId.optional(),
  source: z.string().min(1),
  status: z.enum(LEAD_STATUSES),
  assignedTo: objectId.optional(),
  notes: z.array(z.object({ body: z.string().min(1), by: objectId, at: timestamp })),
  consent: z.object({
    textVersion: z.string().min(1),
    acceptedAt: timestamp,
    ip: z.string().optional(),
  }),
  dedupeKey: z.string().min(1),
});

// quotes
export const quoteLineItemSchema = z.object({
  description: z.string().min(1),
  supplier: z.string().min(1),
  quantity: z.number().int().positive(),
  unitAmountMinor: minor,
  currency,
  notes: z.string().optional(),
});

export const QuoteSchema = z.object({
  ...baseDoc,
  leadId: objectId,
  version: z.number().int().positive(),
  status: z.enum(QUOTE_STATUSES),
  lineItems: z.array(quoteLineItemSchema),
  exclusions: z.array(z.string()),
  terms: z.string(),
  fx: fxSnapshot,
  totals: z.object({ totalMinorPKR: minor, totalMinorSAR: minor }),
  /** Hash only. The raw token exists only in the link sent to the customer. */
  publicTokenHash: z.string().min(1),
  expiresAt: timestamp,
  sentAt: timestamp.optional(),
  acceptedAt: timestamp.optional(),
  replacedById: objectId.optional(),
});

// messages
export const MessageSchema = z.object({
  ...baseDoc,
  leadId: objectId,
  direction: z.enum(['inbound', 'outbound']),
  body: z.string().min(1),
  channel: z.enum(['email', 'whatsapp_manual', 'site']),
  /** Staff user for outbound messages; absent when the customer wrote. */
  by: objectId.optional(),
});

// auditEvents (append-only; has `at` instead of createdAt/updatedAt)
export const AuditEventSchema = z.object({
  _id: objectId.optional(),
  actorId: objectId.optional(),
  actorRole: z.enum([...ROLES, 'public', 'system']),
  action: z.string().min(1),
  entityType: z.string().min(1),
  /** Absent when there is no entity, e.g. a failed login for an unknown email. */
  entityId: objectId.optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  ip: z.string().optional(),
  at: timestamp,
});

export type User = z.infer<typeof UserSchema>;
export type Supplier = z.infer<typeof SupplierSchema>;
export type Hotel = z.infer<typeof HotelSchema>;
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type RatePackage = z.infer<typeof RatePackageSchema>;
export type HotelRate = z.infer<typeof HotelRateSchema>;
export type VisaRate = z.infer<typeof VisaRateSchema>;
export type FxRate = z.infer<typeof FxRateSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type FlightEstimate = z.infer<typeof FlightEstimateSchema>;
export type Calculation = z.infer<typeof CalculationSchema>;
export type Traveler = z.infer<typeof TravelerSchema>;
export type Lead = z.infer<typeof LeadSchema>;
export type QuoteLineItem = z.infer<typeof quoteLineItemSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type City = 'makkah' | 'madinah';
