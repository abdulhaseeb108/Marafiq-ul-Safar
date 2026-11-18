/**
 * travelers, leads, counters, messages and quotes (docs/02 section 1).
 * Travelers hold contact details only: never passport, CNIC or card data.
 */
import {
  INQUIRY_SOURCES,
  LANGUAGES,
  LEAD_STATUSES,
  MESSAGE_CHANNELS,
  QUOTE_STATUSES,
} from '@marafiq/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const { ObjectId, Mixed } = Schema.Types;

const travelerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Normalized "+923001234567". One traveler per phone number. */
    phone: { type: String, required: true, unique: true },
    email: { type: String, default: null },
    language: { type: String, required: true, enum: LANGUAGES },
  },
  { collection: 'travelers', timestamps: true },
);

const leadSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    travelerId: { type: ObjectId, ref: 'Traveler', required: true, index: true },
    /**
     * The contact details given with THIS inquiry. Everything sent or shown for
     * the lead uses these, never the traveler's latest details: a later inquiry
     * from the same phone may leave the email out or come from someone else
     * (a shared family phone), and the quote link must only go where the
     * person asking for this quote said.
     */
    contact: {
      name: { type: String, trim: true },
      email: { type: String, default: null },
      language: { type: String, enum: LANGUAGES },
    },
    calculationId: { type: ObjectId, ref: 'Calculation', default: null },
    /** The calculator inputs, kept even when pricing them failed. */
    tripInputs: { type: Mixed, default: null },
    source: { type: String, required: true, enum: INQUIRY_SOURCES },
    status: { type: String, required: true, enum: LEAD_STATUSES, default: 'new' },
    assignedTo: { type: ObjectId, ref: 'User', default: null },
    /**
     * Bumped by every change to this lead's quotes (create, new version, send).
     * It makes two such changes at the same moment write the same document, so
     * inside transactions one of them is retried and sees the other's result.
     */
    quoteRevision: { type: Number, default: 0 },
    /** What the customer wrote in the form. */
    notesText: { type: String, default: '' },
    /** Staff notes. */
    notes: {
      type: [
        new Schema(
          {
            body: { type: String, required: true },
            by: { type: ObjectId, ref: 'User', required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    consent: {
      textVersion: { type: String, required: true },
      acceptedAt: { type: Date, required: true },
      ip: { type: String },
    },
    /** sha256(phone + trip); the same key within 24 hours is the same inquiry. */
    dedupeKey: { type: String, required: true },
  },
  { collection: 'leads', timestamps: true },
);
leadSchema.index({ dedupeKey: 1, createdAt: -1 });
leadSchema.index({ status: 1, createdAt: -1 });

/** Named sequences, e.g. "lead-2026" for MSF-2026-NNNNNN. */
const counterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: 'counters', versionKey: false },
);

/**
 * One row per inquiry de-duplication key (sha256 of phone + trip, never the
 * phone itself) while its 24-hour window is open. The unique _id is what stops
 * two identical inquiries sent at the same moment from both being stored:
 * the second claim fails, and that request answers with the first one's
 * reference (leads.service.ts, createInquiry). MongoDB removes rows after
 * expiresAt; an expired row that is still present is simply claimed again.
 */
const inquiryClaimSchema = new Schema(
  {
    _id: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'inquiryClaims', versionKey: false },
);
inquiryClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const messageSchema = new Schema(
  {
    leadId: { type: ObjectId, ref: 'Lead', required: true, index: true },
    direction: { type: String, required: true, enum: ['inbound', 'outbound'] },
    body: { type: String, required: true },
    channel: { type: String, required: true, enum: MESSAGE_CHANNELS },
    /** Staff user for outbound messages; absent when the customer wrote. */
    by: { type: ObjectId, ref: 'User', default: null },
    /** The quote the customer was looking at, for questions from /q/:token. */
    quoteId: { type: ObjectId, ref: 'Quote', default: null },
  },
  { collection: 'messages', timestamps: true },
);

const quoteLineSchema = new Schema(
  {
    description: { type: String, required: true },
    supplier: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitAmountMinor: { type: Number, required: true },
    currency: { type: String, required: true, enum: ['SAR', 'PKR'] },
    notes: { type: String, default: '' },
  },
  { _id: false },
);

const quoteSchema = new Schema(
  {
    leadId: { type: ObjectId, ref: 'Lead', required: true, index: true },
    version: { type: Number, required: true },
    status: { type: String, required: true, enum: QUOTE_STATUSES, default: 'draft' },
    lineItems: { type: [quoteLineSchema], default: [] },
    exclusions: { type: [String], default: [] },
    terms: { type: String, default: '' },
    /** Stored with the quote; fixed once sent. */
    fx: {
      type: new Schema({ rate: String, effectiveAt: Date }, { _id: false }),
      default: null,
    },
    totals: {
      totalMinorPKR: { type: Number, required: true, default: 0 },
      totalMinorSAR: { type: Number, required: true, default: 0 },
    },
    /**
     * sha256 of the customer's link token. The raw token is never stored.
     * Unique where present; drafts have none (sparse).
     */
    publicTokenHash: { type: String, default: undefined },
    expiresAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    previousId: { type: ObjectId, ref: 'Quote', default: null },
    replacedById: { type: ObjectId, ref: 'Quote', default: null },
  },
  { collection: 'quotes', timestamps: true },
);
quoteSchema.index({ publicTokenHash: 1 }, { unique: true, sparse: true });
quoteSchema.index({ leadId: 1, version: 1 }, { unique: true });
/**
 * A lead has at most one draft, one sent and one accepted quote at a time (a
 * draft next to a sent quote is the new version being prepared). The services
 * check this themselves; this index is what holds when two requests arrive at
 * the same moment, with or without transactions. Replaced, expired and
 * declined quotes are not limited.
 */
export const ONE_LIVE_QUOTE_INDEX = 'one_live_quote_per_status';
quoteSchema.index(
  { leadId: 1, status: 1 },
  {
    name: ONE_LIVE_QUOTE_INDEX,
    unique: true,
    partialFilterExpression: { status: { $in: ['draft', 'sent', 'accepted'] } },
  },
);

export type TravelerDoc = HydratedDocument<InferSchemaType<typeof travelerSchema>>;
export type LeadDoc = HydratedDocument<InferSchemaType<typeof leadSchema>>;
export type MessageDoc = HydratedDocument<InferSchemaType<typeof messageSchema>>;
export type QuoteDoc = HydratedDocument<InferSchemaType<typeof quoteSchema>>;

type Lang = (typeof LANGUAGES)[number];

/**
 * Who to address for a lead: the details given with that inquiry. A lead saved
 * without them falls back to the traveler's name and language, but never to the
 * traveler's email (it may belong to a different, later inquiry).
 */
export function leadContact(
  lead: {
    contact?: { name?: string | null; email?: string | null; language?: string | null } | null;
  },
  traveler: { name?: string | null; language?: string | null } | null | undefined,
): { name: string; email: string | null; language: Lang } {
  const contact = lead.contact;
  const language = contact?.language ?? traveler?.language ?? 'en';
  return {
    name: contact?.name ?? traveler?.name ?? '',
    email: contact?.email ?? null,
    language: (LANGUAGES as readonly string[]).includes(language) ? (language as Lang) : 'en',
  };
}

export const TravelerModel = model('Traveler', travelerSchema);
export const LeadModel = model('Lead', leadSchema);
export const CounterModel = model('Counter', counterSchema);
export const InquiryClaimModel = model('InquiryClaim', inquiryClaimSchema);
export const MessageModel = model('Message', messageSchema);
export const QuoteModel = model('Quote', quoteSchema);
