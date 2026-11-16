/**
 * Inquiries, leads, quotes and messages: request bodies and the views the API
 * returns (docs/01 sections 5-7, docs/02). Shared by API and web.
 */
import { z } from 'zod';
import { normalizePkMobile } from '../phone.js';
import {
  LANGUAGES,
  LEAD_STATUSES,
  type CustomerVisibleQuoteStatus,
  type Language,
  type LeadStatus,
  type QuoteStatus,
  type Role,
} from '../status.js';
import { isoDate, minor, objectId } from './common.js';
import { CalculateInputSchema, type CalculationResult } from './pricing.js';

/**
 * Version of the consent text the customer agreed to. Change it whenever the
 * wording in the locales (inquiry.consent) changes; leads store the version.
 */
export const CONSENT_TEXT_VERSION = '2026-11-v1';

export const INQUIRY_SOURCES = [
  'umrah',
  'hotels',
  'flights',
  'visa',
  'transport',
  'contact',
] as const;
export type InquirySource = (typeof INQUIRY_SOURCES)[number];

export const MESSAGE_CHANNELS = ['email', 'whatsapp_manual', 'site'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

const pkMobile = z
  .string()
  .trim()
  .min(1, 'Enter your phone number')
  .max(30)
  .refine((value) => normalizePkMobile(value) !== null, {
    message: 'Enter a Pakistani mobile number, e.g. 0300 1234567',
  })
  .transform((value) => normalizePkMobile(value) as string);

/**
 * POST /public/inquiries. Unknown fields are dropped, so passport, CNIC or
 * card numbers sent by mistake are never stored (CLAUDE.md rule 6).
 */
export const InquiryBodySchema = z.object({
  source: z.enum(INQUIRY_SOURCES),
  traveler: z.object({
    name: z.string().trim().min(1, 'Enter your name').max(100),
    phone: pkMobile,
    email: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.email('Enter a valid email or leave it empty').max(200).optional(),
    ),
    language: z.enum(LANGUAGES),
  }),
  notes: z.string().trim().max(2000).default(''),
  consent: z.object({
    accepted: z.literal(true, { error: 'Please agree so we can contact you' }),
    textVersion: z.literal(CONSENT_TEXT_VERSION, { error: 'Please reload the page and try again' }),
  }),
  /** The calculator inputs; the server prices them again and stores the snapshot. */
  inputs: CalculateInputSchema.optional(),
});
export type InquiryBody = z.input<typeof InquiryBodySchema>;
export type InquiryData = z.infer<typeof InquiryBodySchema>;

export interface InquiryResponse {
  reference: string;
  /** True when the same phone sent the same trip in the last 24 hours. */
  duplicate: boolean;
  responseTimeText: string;
}

// --- Admin: leads ----------------------------------------------------------

export const LeadListQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  /** "me", "unassigned" or a user id. */
  assigned: z.union([z.enum(['me', 'unassigned']), objectId]).optional(),
  /** Reference, phone digits or part of the name. */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;

export const UpdateLeadBodySchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    /** null unassigns. */
    assignedTo: objectId.nullable().optional(),
  })
  .refine((body) => body.status !== undefined || body.assignedTo !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateLeadBody = z.infer<typeof UpdateLeadBodySchema>;

export const LeadNoteBodySchema = z.object({ body: z.string().trim().min(1).max(2000) });

/** A reply staff sent outside the site, logged on the lead. */
export const LeadMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(2000),
  channel: z.enum(['email', 'whatsapp_manual']),
});

export interface LeadSummary {
  id: string;
  reference: string;
  status: LeadStatus;
  source: InquirySource;
  travelerName: string;
  /** "0300 1234567". */
  phone: string;
  assignedTo: { id: string; name: string } | null;
  createdAt: string;
  latestQuote: { id: string; version: number; status: QuoteStatus } | null;
}

export interface LeadNoteView {
  body: string;
  by: string;
  at: string;
}

export interface MessageView {
  id: string;
  direction: 'inbound' | 'outbound';
  channel: MessageChannel;
  body: string;
  byName: string | null;
  createdAt: string;
}

export interface QuoteSummary {
  id: string;
  version: number;
  status: QuoteStatus;
  totalMinorPKR: number;
  totalMinorSAR: number;
  expiresAt: string;
  sentAt: string | null;
  acceptedAt: string | null;
}

export interface LeadDetail extends LeadSummary {
  traveler: { name: string; phone: string; email: string | null; language: Language };
  notesText: string;
  consent: { textVersion: string; acceptedAt: string };
  /** The trip the customer asked about, when it came from the calculator. */
  tripInputs: CalculationResult['inputs'] | null;
  calculation: CalculationResult | null;
  notes: LeadNoteView[];
  messages: MessageView[];
  /** Absent for roles that may not see quotes (ops). */
  quotes?: QuoteSummary[];
  /** Statuses staff can move this lead to now. */
  nextStatuses: LeadStatus[];
}

export interface Assignee {
  id: string;
  name: string;
  role: Role;
}

// --- Admin: quotes ---------------------------------------------------------

export const QuoteLineItemInputSchema = z.object({
  description: z.string().trim().min(1, 'Describe the item').max(300),
  supplier: z.string().trim().min(1, 'Name the supplier').max(150),
  quantity: z.number().int().min(1).max(999),
  unitAmountMinor: minor.max(1_000_000_000),
  currency: z.enum(['SAR', 'PKR']),
  notes: z.string().trim().max(300).default(''),
});
export type QuoteLineItemInput = z.input<typeof QuoteLineItemInputSchema>;

/** PUT /admin/quotes/:id (drafts only). */
export const UpdateQuoteBodySchema = z.object({
  lineItems: z.array(QuoteLineItemInputSchema).max(50),
  exclusions: z.array(z.string().trim().min(1).max(300)).max(30),
  terms: z.string().trim().max(5000),
  /** Last day the quote is valid; it ends at 23:59 Pakistan time. */
  expiresOn: isoDate,
});
export type UpdateQuoteBody = z.input<typeof UpdateQuoteBodySchema>;

export interface QuoteLineView {
  description: string;
  supplier: string;
  quantity: number;
  unitAmountMinor: number;
  currency: 'SAR' | 'PKR';
  notes: string;
  amountMinor: number;
  amountMinorSAR: number;
  amountMinorPKR: number;
}

export interface QuoteDetail {
  id: string;
  leadId: string;
  reference: string;
  version: number;
  status: QuoteStatus;
  lineItems: QuoteLineView[];
  exclusions: string[];
  terms: string;
  fx: { rate: string; effectiveAt: string } | null;
  totals: { totalMinorPKR: number; totalMinorSAR: number };
  expiresAt: string;
  sentAt: string | null;
  acceptedAt: string | null;
  /** The version this one replaces, and the one that replaced it. */
  previousId: string | null;
  replacedById: string | null;
  /** Every quote for the lead, newest first. */
  history: QuoteSummary[];
  /** Calculator items that still need a price, for reference while building. */
  missingFromCalculation: string[];
}

export interface SendQuoteResponse {
  /** The private link. Shown once; only its hash is stored. */
  link: string;
  emailed: boolean;
  quote: QuoteDetail;
}

// --- Public quote page -----------------------------------------------------

export const QUOTE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const PublicQuoteQuerySchema = z.object({
  /** Show the newest version this link has been replaced by. */
  follow: z.enum(['latest']).optional(),
});

export const PublicQuoteMessageBodySchema = z.object({
  body: z.string().trim().min(1, 'Write your question').max(2000),
});

export interface PublicQuoteView {
  reference: string;
  version: number;
  /** Show it with customerQuoteStatusLabel(): the wording map is the only status text. */
  status: CustomerVisibleQuoteStatus;
  travelerName: string;
  lineItems: QuoteLineView[];
  exclusions: string[];
  terms: string;
  fx: { rate: string; effectiveAt: string };
  totals: { totalMinorPKR: number; totalMinorSAR: number };
  sentAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  canAccept: boolean;
  /** True when this view is the newest version reached from an older link. */
  viaOlderLink: boolean;
  /** For a replaced quote: a newer sent version can be opened with ?follow=latest. */
  hasNewerVersion: boolean;
}
