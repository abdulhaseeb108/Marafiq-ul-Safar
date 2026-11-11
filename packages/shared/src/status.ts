/**
 * Statuses, allowed transitions and customer-facing wording.
 * Defined once here (CLAUDE.md hard rule 2, docs/02 section 2).
 *
 * These are pure rules. Writing the audit event for each transition is the
 * job of the API service that performs it (Phase 1 onwards).
 */

export const ROLES = ['admin', 'sales', 'ops', 'finance'] as const;
export type Role = (typeof ROLES)[number];

export const LANGUAGES = ['en', 'ur'] as const;
export type Language = (typeof LANGUAGES)[number];

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

// --- Rate package ---------------------------------------------------------
export const RATE_PACKAGE_STATUSES = [
  'draft',
  'needs_review',
  'published',
  'superseded',
  'rejected',
] as const;
export type RatePackageStatus = (typeof RATE_PACKAGE_STATUSES)[number];

/** draft -> needs_review -> published -> superseded; draft|needs_review -> rejected. */
export const RATE_PACKAGE_TRANSITIONS: TransitionTable<RatePackageStatus> = {
  draft: ['needs_review', 'rejected'],
  needs_review: ['published', 'rejected'],
  published: ['superseded'],
  superseded: [],
  rejected: [],
};

// --- Source document extraction (docs/01 section 6.3) ---------------------
export const EXTRACTION_STATUSES = [
  'uploaded',
  'extracting',
  'needs_review',
  'published',
  'rejected',
  'superseded',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// --- Lead -----------------------------------------------------------------
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'quote_in_progress',
  'quote_sent',
  'accepted',
  'declined',
  'lost',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** new -> contacted -> quote_in_progress -> quote_sent -> accepted|declined|lost; any -> lost. */
export const LEAD_TRANSITIONS: TransitionTable<LeadStatus> = {
  new: ['contacted', 'lost'],
  contacted: ['quote_in_progress', 'lost'],
  quote_in_progress: ['quote_sent', 'lost'],
  quote_sent: ['accepted', 'declined', 'lost'],
  accepted: ['lost'],
  declined: ['lost'],
  lost: [],
};

// --- Quote ----------------------------------------------------------------
export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'replaced',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** draft -> sent -> accepted | declined | expired | replaced. */
export const QUOTE_TRANSITIONS: TransitionTable<QuoteStatus> = {
  draft: ['sent'],
  sent: ['accepted', 'declined', 'expired', 'replaced'],
  accepted: [],
  declined: [],
  expired: [],
  replaced: [],
};

// --- Transition helpers ---------------------------------------------------
export class StatusTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Status cannot change from "${from}" to "${to}"`);
    this.name = 'StatusTransitionError';
  }
}

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  if (!canTransition(table, from, to)) throw new StatusTransitionError(from, to);
}

// --- Customer wording -----------------------------------------------------
export type CustomerVisibleQuoteStatus = Exclude<QuoteStatus, 'draft'>;

/**
 * The only status text a customer ever sees. "Draft" is staff-only and has no
 * entry. Never "booked"; never "confirmed" (no status means that yet).
 * Urdu is an AI draft: [URDU REVIEW] needed before launch (docs/05 #15).
 */
export const CUSTOMER_QUOTE_STATUS_WORDING: Readonly<
  Record<Language, Readonly<Record<CustomerVisibleQuoteStatus, string>>>
> = {
  en: {
    sent: 'Quote sent',
    accepted: 'Request accepted — we will confirm with suppliers',
    declined: 'Quote declined',
    expired: 'Expired — request a new quote',
    replaced: 'This quote was replaced',
  },
  ur: {
    sent: 'کوٹیشن بھیج دی گئی',
    accepted: 'درخواست قبول ہو گئی — ہم سپلائرز سے تصدیق کریں گے',
    declined: 'کوٹیشن مسترد کر دی گئی',
    expired: 'میعاد ختم — نئی کوٹیشن کی درخواست کریں',
    replaced: 'یہ کوٹیشن تبدیل کر دی گئی ہے',
  },
};

/** Returns null for statuses a customer must not see (draft). */
export function customerQuoteStatusLabel(status: QuoteStatus, language: Language): string | null {
  if (status === 'draft') return null;
  return CUSTOMER_QUOTE_STATUS_WORDING[language][status];
}
