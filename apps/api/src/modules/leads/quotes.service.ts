/**
 * Quotes (docs/01 section 7): drafts staff edit, versions, sending, and the
 * customer's private link.
 *
 * Link security: the token is 32 random bytes (base64url, 43 characters). Only
 * its sha256 is stored, so the database alone cannot recreate a link. Lookups
 * are by that hash only, and every unknown or malformed token gets the same
 * 404, so tokens cannot be guessed or enumerated. Public answers carry no
 * internal ids.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  LEAD_TRANSITIONS,
  QUOTE_TOKEN_PATTERN,
  QUOTE_TRANSITIONS,
  assertTransition,
  quoteLineAmounts,
  quoteTotals,
  type CalculationResult,
  type CustomerVisibleQuoteStatus,
  type Language,
  type LeadStatus,
  type PublicQuoteView,
  type QuoteDetail,
  type QuoteLineView,
  type SendQuoteResponse,
  type UpdateQuoteBody,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import { HttpError, conflict, isDuplicateKeyError, notFound } from '../../lib/http-error.js';
import { SYSTEM_ACTOR } from '../../lib/actor.js';
import { inTransaction } from '../../lib/transaction.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { getCurrentFx } from '../fx/fx.service.js';
import { addDays } from '../pricing/engine.js';
import { getCalculation, todayInPakistan } from '../pricing/pricing.service.js';
import { quoteSent, sendQuietly, staffNotice } from './emails.js';
import {
  LeadModel,
  MessageModel,
  QuoteModel,
  TravelerModel,
  leadContact,
  type LeadDoc,
  type QuoteDoc,
} from './lead.models.js';
import {
  OPEN_LEAD_STATUSES,
  advanceLead,
  leadClosed,
  quoteSummary,
  storedLeadStatus,
  syncLeadStatus,
  type LeadsDeps,
} from './leads.service.js';

const id = (value: unknown) => String(value);
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);

export const DEFAULT_QUOTE_TERMS = [
  'Prices are in the currencies shown, converted at the exchange rate on this quote.',
  'Rates can change without notice until each supplier confirms.',
  'Accepting this quote is a request: we then confirm every part with the suppliers and arrange payment with you.',
  'Visa decisions rest with the issuing authority.',
].join('\n');

/** How long a new quote is valid by default, in days after today (Pakistan time). */
const DEFAULT_VALID_DAYS = 3;

/** End of a day in Pakistan time (UTC+5, no daylight saving). */
export function endOfDayPakistan(date: string): Date {
  return new Date(`${date}T23:59:59.999+05:00`);
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashQuoteToken(token) };
}

export function hashQuoteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const quoteLink = (deps: LeadsDeps, token: string) => `${deps.config.publicSiteUrl}/q/${token}`;

async function loadQuote(quoteId: string): Promise<QuoteDoc> {
  const quote = mongoose.isValidObjectId(quoteId) ? await QuoteModel.findById(quoteId) : null;
  if (!quote) throw notFound('Quote');
  return quote;
}

async function loadLeadOf(quote: QuoteDoc): Promise<LeadDoc> {
  const lead = await LeadModel.findById(quote.leadId);
  if (!lead) throw notFound('Lead');
  return lead;
}

/** Paths a concurrent writer can change on a sent quote. */
const LIVE_QUOTE_PATHS = ['status', 'acceptedAt', 'expiresAt', 'replacedById'] as const;

/**
 * After a conditional write did not match, bring the in-memory quote up to date
 * with what is stored (callers keep using the same object). The paths are not
 * marked modified, so nothing stale can be written back later.
 */
async function syncQuoteState(quote: QuoteDoc): Promise<QuoteDoc> {
  const current = await QuoteModel.findById(quote._id).select(LIVE_QUOTE_PATHS.join(' ')).lean();
  if (!current) throw notFound('Quote');
  for (const path of LIVE_QUOTE_PATHS) {
    quote.set(path, current[path]);
    quote.unmarkModified(path);
  }
  return quote;
}

/** A sent quote past its expiry becomes "expired" the first time anyone looks. */
export async function refreshExpiry(quote: QuoteDoc, now: Date = new Date()): Promise<QuoteDoc> {
  if (quote.status !== 'sent' || quote.expiresAt.getTime() > now.getTime()) return quote;
  assertTransition(QUOTE_TRANSITIONS, 'sent', 'expired');
  // Conditional on the stored state, not this copy: the customer may have
  // accepted it (or staff replaced or declined it) since it was read, and an
  // accepted quote must never become "expired".
  const expired = await QuoteModel.updateOne(
    { _id: quote._id, status: 'sent', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  );
  if (expired.matchedCount === 0) return syncQuoteState(quote);
  quote.set('status', 'expired');
  quote.unmarkModified('status');
  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: 'quote.expire',
    entityType: 'quote',
    entityId: quote.id as string,
    before: { status: 'sent' },
    after: { status: 'expired' },
  });
  return quote;
}

function lineViews(quote: QuoteDoc): QuoteLineView[] {
  return quote.lineItems.map((line) => {
    const base = {
      description: line.description,
      supplier: line.supplier,
      quantity: line.quantity,
      unitAmountMinor: line.unitAmountMinor,
      currency: line.currency as 'SAR' | 'PKR',
      notes: line.notes ?? '',
    };
    const amounts = quote.fx?.rate
      ? quoteLineAmounts(base, quote.fx.rate)
      : {
          amountMinor: base.quantity * base.unitAmountMinor,
          amountMinorSAR: base.currency === 'SAR' ? base.quantity * base.unitAmountMinor : 0,
          amountMinorPKR: base.currency === 'PKR' ? base.quantity * base.unitAmountMinor : 0,
        };
    return { ...base, ...amounts };
  });
}

function missingFrom(calculation: CalculationResult | null): string[] {
  return calculation ? calculation.missing.map((m) => m.message) : [];
}

export async function getQuoteDetail(quoteId: string): Promise<QuoteDetail> {
  const quote = await refreshExpiry(await loadQuote(quoteId));
  const lead = await loadLeadOf(quote);
  const history = await QuoteModel.find({ leadId: lead._id }).sort({ version: -1 }).lean();
  const calculation = lead.calculationId ? await getCalculation(id(lead.calculationId)) : null;
  return {
    id: quote.id as string,
    leadId: lead.id as string,
    reference: lead.reference,
    version: quote.version,
    status: quote.status as QuoteDetail['status'],
    lineItems: lineViews(quote),
    exclusions: [...quote.exclusions],
    terms: quote.terms ?? '',
    fx: quote.fx?.rate
      ? { rate: quote.fx.rate, effectiveAt: (quote.fx.effectiveAt as Date).toISOString() }
      : null,
    totals: {
      totalMinorPKR: quote.totals?.totalMinorPKR ?? 0,
      totalMinorSAR: quote.totals?.totalMinorSAR ?? 0,
    },
    expiresAt: quote.expiresAt.toISOString(),
    sentAt: iso(quote.sentAt),
    acceptedAt: iso(quote.acceptedAt),
    previousId: quote.previousId ? id(quote.previousId) : null,
    replacedById: quote.replacedById ? id(quote.replacedById) : null,
    history: history.map(quoteSummary),
    missingFromCalculation: missingFrom(calculation),
  };
}

/** Lines and exclusions to start from: the calculator's priced items, in SAR. */
function prefillFrom(calculation: CalculationResult | null) {
  if (!calculation) return { lineItems: [], exclusions: [] as string[] };
  const lineItems = calculation.lineItems.flatMap((line) => {
    if (line.kind === 'flight') return [];
    const source = `${line.source.packName}, sheet dated ${line.source.issueDate ?? 'not stated'}`;
    const units =
      line.kind === 'hotel'
        ? (line.basis === 'per_person' ? line.persons : 1) * line.nights * line.rooms
        : line.persons;
    // Keep quantity x unit when it equals the amount (no markup); otherwise one line at the amount.
    const exact = units * line.unitMinorSAR === line.amountMinorSAR;
    const description =
      line.kind === 'hotel'
        ? `${line.hotelName} (${line.city === 'makkah' ? 'Makkah' : 'Madinah'}), ${line.occupancy.replace('_', ' ')}, ${line.firstNight} to ${line.lastNight}, ${line.nights} night(s)`
        : line.label.replace(/ × SAR [\d,.]+$/, '');
    return [
      {
        description,
        supplier: line.source.supplierName,
        quantity: exact ? units : 1,
        unitAmountMinor: exact ? line.unitMinorSAR : line.amountMinorSAR,
        currency: 'SAR' as const,
        notes: source,
      },
    ];
  });
  const exclusions = calculation.exclusions
    .filter((note) => note.code !== 'request_a_quote')
    .map((note) => note.message);
  return { lineItems, exclusions };
}

async function currentFx() {
  const fx = await getCurrentFx(new Date());
  return fx ? { rate: fx.rate, effectiveAt: fx.effectiveAt } : null;
}

async function nextVersion(leadId: mongoose.Types.ObjectId): Promise<number> {
  const last = await QuoteModel.findOne({ leadId }).sort({ version: -1 }).select('version').lean();
  return (last?.version ?? 0) + 1;
}

// --- One live quote per lead ---------------------------------------------------
//
// A lead has at most one draft, one sent and one accepted quote. Three things
// keep that true when two requests arrive at the same moment:
//  1. Every change to a lead's quotes first writes the lead (lockLeadQuotes).
//     Inside transactions (production) two such changes then conflict, MongoDB
//     runs one of them again, and its checks see what the other one stored.
//  2. The checks run again inside that unit of work, on the stored state.
//  3. A unique index (ONE_LIVE_QUOTE_INDEX) refuses the second write whatever
//     happens, also on a single server without transactions. Its duplicate-key
//     error becomes a 409 here, never a 500.

const draftExists = (existingId: string) =>
  new HttpError(409, 'draft_exists', 'This lead already has a draft quote. Open it instead.', {
    existingId,
  });
const sentExists = (existingId: string) =>
  new HttpError(
    409,
    'open_quote_exists',
    'This lead has a sent quote. Make a new version of it instead.',
    { existingId },
  );
const otherQuoteSent = (existingId: string) =>
  new HttpError(
    409,
    'other_quote_sent',
    'The customer already has another quote for this lead. Make a new version of that one instead.',
    { existingId },
  );

/**
 * Write the lead before changing its quotes, and return it as stored now.
 * See (1) above. Call it first inside inTransaction().
 */
async function lockLeadQuotes(leadId: mongoose.Types.ObjectId): Promise<LeadDoc> {
  const lead = await LeadModel.findOneAndUpdate(
    { _id: leadId },
    { $inc: { quoteRevision: 1 } },
    { returnDocument: 'after' },
  );
  if (!lead) throw notFound('Lead');
  return lead;
}

/** Refuse if the lead has a draft, or a sent quote the customer can still accept. */
async function assertNoOpenQuote(leadId: mongoose.Types.ObjectId, now: Date): Promise<void> {
  const open = await QuoteModel.findOne({
    leadId,
    $or: [{ status: 'draft' }, { status: 'sent', expiresAt: { $gt: now } }],
  })
    .select('status')
    .lean();
  if (!open) return;
  throw open.status === 'draft' ? draftExists(id(open._id)) : sentExists(id(open._id));
}

/** What to answer when the index refused a second draft: point at the one that won. */
async function draftConflict(leadId: mongoose.Types.ObjectId): Promise<HttpError> {
  const draft = await QuoteModel.findOne({ leadId, status: 'draft' }).select('_id').lean();
  return draft ? draftExists(id(draft._id)) : conflict();
}

/** POST /admin/leads/:id/quotes: a new draft, prefilled from the calculation. */
export async function createQuote(leadId: string, actor: Actor): Promise<QuoteDetail> {
  const found = mongoose.isValidObjectId(leadId) ? await LeadModel.findById(leadId) : null;
  if (!found) throw notFound('Lead');

  // The friendly check, which also expires a sent quote whose deadline passed.
  // It is repeated on the stored state inside the unit of work below.
  for (const open of await QuoteModel.find({
    leadId: found._id,
    status: { $in: ['draft', 'sent'] },
  })) {
    await refreshExpiry(open);
    if (open.status === 'draft') throw draftExists(open.id as string);
    if (open.status === 'sent') throw sentExists(open.id as string);
  }

  const calculation = found.calculationId ? await getCalculation(id(found.calculationId)) : null;
  const prefill = prefillFrom(calculation);
  const fx = await currentFx();

  let quote: QuoteDoc;
  try {
    quote = await inTransaction(async () => {
      // Read again on every attempt: a retried transaction starts from the
      // stored lead, not from what an abandoned attempt left in memory.
      const lead = await lockLeadQuotes(found._id);
      await assertNoOpenQuote(lead._id, new Date());
      await advanceLead(lead, 'quote_in_progress', actor);
      const quote = await QuoteModel.create({
        leadId: lead._id,
        version: await nextVersion(lead._id),
        status: 'draft',
        lineItems: prefill.lineItems,
        exclusions: prefill.exclusions,
        terms: DEFAULT_QUOTE_TERMS,
        fx,
        totals: fx
          ? quoteTotals(prefill.lineItems, fx.rate)
          : { totalMinorPKR: 0, totalMinorSAR: 0 },
        expiresAt: endOfDayPakistan(addDays(todayInPakistan(), DEFAULT_VALID_DAYS)),
      });
      // Without transactions another draft may have been created AND sent
      // between the check above and this insert (the index only sees drafts
      // that are still drafts). Look once more now that ours is stored, and
      // withdraw it rather than leave a draft that could never be sent.
      const sent = await QuoteModel.findOne({
        leadId: lead._id,
        status: 'sent',
        expiresAt: { $gt: new Date() },
      })
        .select('_id')
        .lean();
      if (sent) {
        await QuoteModel.deleteOne({ _id: quote._id, status: 'draft' });
        throw sentExists(id(sent._id));
      }
      await recordAudit({
        actor,
        action: 'quote.create',
        entityType: 'quote',
        entityId: quote.id as string,
        after: {
          leadReference: lead.reference,
          version: quote.version,
          lines: prefill.lineItems.length,
        },
      });
      return quote;
    });
  } catch (error) {
    // Someone else's draft got there first (same version number, or the
    // one-draft index). Nothing of ours was stored.
    if (isDuplicateKeyError(error)) throw await draftConflict(found._id);
    throw error;
  }
  return getQuoteDetail(quote.id as string);
}

const notDraft = () =>
  new HttpError(409, 'quote_not_draft', 'Only a draft can be changed. Make a new version instead.');

/** PUT /admin/quotes/:id: drafts only. Totals and FX are recalculated here. */
export async function updateQuote(
  quoteId: string,
  body: UpdateQuoteBody,
  actor: Actor,
): Promise<QuoteDetail> {
  const quote = await loadQuote(quoteId);
  if (quote.status !== 'draft') throw notDraft();
  if (body.expiresOn < todayInPakistan()) {
    throw new HttpError(400, 'validation_error', 'Please check the highlighted fields', {
      expiresOn: 'Choose today or a later date',
    });
  }
  const fx = await currentFx();
  if (!fx) {
    throw new HttpError(503, 'prices_unavailable', 'Set an exchange rate before building quotes.');
  }
  const lineItems = body.lineItems.map((line) => ({ ...line, notes: line.notes ?? '' }));
  const before = { lines: quote.lineItems.length, totals: { ...quote.totals } };
  const totals = quoteTotals(lineItems, fx.rate);
  const expiresAt = endOfDayPakistan(body.expiresOn);
  // Conditional on the stored status, not the copy checked above: the draft may
  // be sent at this very moment, and a sent quote must never change.
  const updated = await QuoteModel.findOneAndUpdate(
    { _id: quote._id, status: 'draft' },
    { $set: { lineItems, exclusions: body.exclusions, terms: body.terms, fx, totals, expiresAt } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) throw notDraft();
  await recordAudit({
    actor,
    action: 'quote.update',
    entityType: 'quote',
    entityId: quote.id as string,
    before,
    after: { lines: lineItems.length, totals: { ...totals }, expiresAt },
  });
  return getQuoteDetail(quote.id as string);
}

const alreadySent = () => new HttpError(409, 'quote_not_draft', 'This quote was already sent.');
const previousAccepted = () =>
  new HttpError(
    409,
    'previous_accepted',
    'The customer already accepted the previous version. Talk to them before sending a new one.',
  );

/** POST /admin/quotes/:id/send: freezes the draft, makes the link, replaces the previous version. */
export async function sendQuote(
  quoteId: string,
  actor: Actor,
  deps: LeadsDeps,
): Promise<SendQuoteResponse> {
  const quote = await loadQuote(quoteId);
  if (quote.status !== 'draft') throw alreadySent();
  if (quote.lineItems.length === 0) {
    throw new HttpError(400, 'quote_empty', 'Add at least one line before sending.');
  }
  if (!quote.fx?.rate) throw new HttpError(400, 'quote_unsaved', 'Save the quote before sending.');
  if (quote.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'validation_error', 'Please check the highlighted fields', {
      expiresOn: 'Choose today or a later date',
    });
  }
  const lead = await loadLeadOf(quote);
  const previous = quote.previousId ? await QuoteModel.findById(quote.previousId) : null;
  if (previous) {
    await refreshExpiry(previous);
    if (previous.status === 'accepted') throw previousAccepted();
  }
  // A closed lead (lost, declined, accepted) gets no more quotes: refuse before writing.
  if (!OPEN_LEAD_STATUSES.includes(lead.status as LeadStatus)) throw leadClosed();
  // The customer holds one quote at a time. The version this draft replaces is
  // dealt with below; any other sent quote for the lead stops the send.
  const notOthers = [quote._id, ...(previous ? [previous._id] : [])];
  for (const other of await QuoteModel.find({
    leadId: lead._id,
    status: 'sent',
    _id: { $nin: notOthers },
  })) {
    await refreshExpiry(other);
    if (other.status === 'sent') throw otherQuoteSent(other.id as string);
  }

  const { token, hash } = newToken();
  const send = async () => {
    // Writes below are conditional on the stored state, not the copies loaded
    // above. The lead goes first: it may have been closed since it was read, and
    // this write only matches an open lead, so a closed lead stops the send
    // before any quote is touched, even without transactions (with one, a close
    // at the same moment also conflicts with this write). Then the previous
    // version (the customer may accept it at this moment), then the draft
    // (another staff click may send it), so a refusal leaves nothing half-done.
    // This lead write is also what makes two sends (or a send and a new draft)
    // for one lead conflict inside transactions; see "One live quote per lead".
    const openLead = await LeadModel.findOneAndUpdate(
      { _id: lead._id, status: { $in: OPEN_LEAD_STATUSES } },
      { $set: { updatedAt: new Date() }, $inc: { quoteRevision: 1 } },
      { returnDocument: 'after' },
    );
    if (!openLead) throw leadClosed();
    // Again on the stored state, before anything else is touched.
    const otherSent = await QuoteModel.findOne({
      leadId: lead._id,
      status: 'sent',
      _id: { $nin: notOthers },
    })
      .select('_id')
      .lean();
    if (otherSent) throw otherQuoteSent(id(otherSent._id));
    await advanceLead(openLead, 'quote_sent', actor);
    if (previous) {
      // The old link now shows "This quote was replaced" and leads to this one.
      assertTransition(QUOTE_TRANSITIONS, 'sent', 'replaced');
      let previousStatus = 'replaced';
      const replaced = await QuoteModel.updateOne(
        { _id: previous._id, status: 'sent' },
        { $set: { status: 'replaced', replacedById: quote._id } },
      );
      let alreadyLinked = false;
      if (replaced.matchedCount === 0) {
        // Not "sent" any more (expired or declined): only link it, unless accepted.
        // (The link does not change the status, so the copy from before the write has it.)
        const linked = await QuoteModel.findOneAndUpdate(
          { _id: previous._id, status: { $ne: 'accepted' } },
          { $set: { replacedById: quote._id } },
          { returnDocument: 'before' },
        ).lean();
        if (!linked) throw previousAccepted();
        previousStatus = linked.status;
        // Another click on "Send" for this same draft got here first: nothing changed,
        // so nothing to record (that click records it; this one stops at the draft below).
        alreadyLinked = id(linked.replacedById) === id(quote._id);
      }
      if (!alreadyLinked) {
        await recordAudit({
          actor,
          action: 'quote.replace',
          entityType: 'quote',
          entityId: previous.id as string,
          after: { status: previousStatus, replacedBy: quote.id as string },
        });
      }
    }
    assertTransition(QUOTE_TRANSITIONS, 'draft', 'sent');
    const sentAt = new Date();
    const sent = await QuoteModel.updateOne(
      { _id: quote._id, status: 'draft' },
      { $set: { status: 'sent', sentAt, publicTokenHash: hash } },
    );
    if (sent.matchedCount === 0) throw alreadySent();
    quote.set({ status: 'sent', sentAt, publicTokenHash: hash });
    await recordAudit({
      actor,
      action: 'quote.send',
      entityType: 'quote',
      entityId: quote.id as string,
      before: { status: 'draft' },
      after: { status: 'sent', version: quote.version },
    });
  };
  try {
    await inTransaction(send);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // The index refused "sent": another quote for this lead was sent between
    // the check and the write. A transaction has undone everything already.
    // Without one, the step that replaced the previous version is taken back
    // (each write matches only what this send itself stored, so after a
    // rolled-back transaction they match nothing).
    const other = await QuoteModel.findOne({
      leadId: lead._id,
      status: 'sent',
      _id: { $ne: quote._id },
    })
      .select('_id')
      .lean();
    if (previous) {
      const unlinked = await QuoteModel.updateOne(
        { _id: previous._id, status: { $ne: 'replaced' }, replacedById: quote._id },
        { $set: { replacedById: null } },
      );
      // Back to "sent" if no other quote holds that place. If one does, it is
      // the quote the customer now has: the old link leads there, not to a draft.
      const undone = await QuoteModel.updateOne(
        { _id: previous._id, status: 'replaced', replacedById: quote._id },
        { $set: other ? { replacedById: other._id } : { status: 'sent', replacedById: null } },
      ).catch((undoError: unknown) => {
        if (isDuplicateKeyError(undoError)) return { matchedCount: 0 };
        throw undoError;
      });
      if (unlinked.matchedCount + undone.matchedCount > 0) {
        await recordAudit({
          actor,
          action: 'quote.replace_undone',
          entityType: 'quote',
          entityId: previous.id as string,
          after: { notReplacedBy: quote.id as string, replacedBy: other ? id(other._id) : null },
        });
      }
    }
    throw other ? otherQuoteSent(id(other._id)) : conflict();
  }

  const link = quoteLink(deps, token);
  // Only the email given with this lead's inquiry; no email given = staff share the link.
  const traveler = await TravelerModel.findById(lead.travelerId).select('name language').lean();
  const contact = leadContact(lead, traveler);
  const emailed = contact.email
    ? await sendQuietly(
        deps.email,
        quoteSent(
          contact.email,
          contact.language as Language,
          lead.reference,
          quote.version,
          link,
          quote.expiresAt,
        ),
      )
    : false;
  return { link, emailed, quote: await getQuoteDetail(quote.id as string) };
}

/** POST /admin/quotes/:id/new-version: a draft copy of a sent quote. */
export async function newQuoteVersion(quoteId: string, actor: Actor): Promise<QuoteDetail> {
  const source = await refreshExpiry(await loadQuote(quoteId));
  const notSent = () =>
    new HttpError(409, 'quote_not_sent', 'Only a sent quote can get a new version.');
  if (source.status !== 'sent') throw notSent();
  const existingDraft = () =>
    QuoteModel.findOne({ leadId: source.leadId, status: 'draft' }).select('_id').lean();
  const draft = await existingDraft();
  if (draft) throw draftExists(id(draft._id));
  const fx =
    (await currentFx()) ??
    (source.fx?.rate ? { rate: source.fx.rate, effectiveAt: source.fx.effectiveAt } : null);
  const lineItems = source.lineItems.map((line) => ({
    description: line.description,
    supplier: line.supplier,
    quantity: line.quantity,
    unitAmountMinor: line.unitAmountMinor,
    currency: line.currency,
    notes: line.notes ?? '',
  }));
  let copy: QuoteDoc;
  try {
    copy = await inTransaction(async () => {
      // Same protection as createQuote: see "One live quote per lead".
      await lockLeadQuotes(source.leadId);
      // On the stored state: the source may have been accepted, declined or
      // replaced, and another draft created, since the checks above.
      if (!(await QuoteModel.exists({ _id: source._id, status: 'sent' }))) throw notSent();
      const racing = await existingDraft();
      if (racing) throw draftExists(id(racing._id));
      const copy = await QuoteModel.create({
        leadId: source.leadId,
        version: await nextVersion(source.leadId),
        status: 'draft',
        lineItems,
        exclusions: [...source.exclusions],
        terms: source.terms,
        fx,
        totals: fx?.rate
          ? quoteTotals(
              lineItems as { quantity: number; unitAmountMinor: number; currency: 'SAR' | 'PKR' }[],
              fx.rate,
            )
          : { totalMinorPKR: 0, totalMinorSAR: 0 },
        expiresAt: endOfDayPakistan(addDays(todayInPakistan(), DEFAULT_VALID_DAYS)),
        previousId: source._id,
      });
      await recordAudit({
        actor,
        action: 'quote.new_version',
        entityType: 'quote',
        entityId: copy.id as string,
        after: { from: source.id as string, version: copy.version },
      });
      return copy;
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) throw await draftConflict(source.leadId);
    throw error;
  }
  return getQuoteDetail(copy.id as string);
}

/** POST /admin/quotes/:id/link: a fresh link for a sent quote; the old link stops working. */
export async function rotateQuoteLink(
  quoteId: string,
  actor: Actor,
  deps: LeadsDeps,
): Promise<{ link: string }> {
  const quote = await refreshExpiry(await loadQuote(quoteId));
  const notSent = () =>
    new HttpError(409, 'quote_not_sent', 'Only a sent quote has a link to renew.');
  if (quote.status !== 'sent') throw notSent();
  const { token, hash } = newToken();
  // Conditional on the stored state, not the copy checked above (and never a
  // save of that copy, which would write it back): the customer may accept the
  // quote, or staff replace or decline it, at this moment. Then the link they
  // hold stays as it is and nothing is renewed.
  const renewed = await QuoteModel.updateOne(
    { _id: quote._id, status: 'sent', expiresAt: { $gt: new Date() } },
    { $set: { publicTokenHash: hash } },
  );
  if (renewed.matchedCount === 0) throw notSent();
  await recordAudit({
    actor,
    action: 'quote.link_renewed',
    entityType: 'quote',
    entityId: quote.id as string,
  });
  return { link: quoteLink(deps, token) };
}

// --- Public: /q/:token --------------------------------------------------------

const linkNotFound = () =>
  new HttpError(404, 'quote_not_found', 'This link is not valid. Please check it or contact us.');

/** The quote a token opens; with follow, the newest version it was replaced by. */
async function resolveToken(
  token: string,
  follow: boolean,
): Promise<{ quote: QuoteDoc; viaOlderLink: boolean }> {
  if (!QUOTE_TOKEN_PATTERN.test(token)) throw linkNotFound();
  let quote = await QuoteModel.findOne({ publicTokenHash: hashQuoteToken(token) });
  if (!quote) throw linkNotFound();
  await refreshExpiry(quote);
  let viaOlderLink = false;
  if (follow) {
    for (let hops = 0; quote.replacedById && hops < 50; hops += 1) {
      const next: QuoteDoc | null = await QuoteModel.findById(quote.replacedById);
      if (!next || next.status === 'draft') break;
      quote = await refreshExpiry(next);
      viaOlderLink = true;
    }
  }
  return { quote, viaOlderLink };
}

async function publicView(quote: QuoteDoc, viaOlderLink: boolean): Promise<PublicQuoteView> {
  const lead = await loadLeadOf(quote);
  const traveler = await TravelerModel.findById(lead.travelerId).select('name language').lean();
  // Only sent quotes have tokens, so a customer never sees a draft.
  const status = quote.status as CustomerVisibleQuoteStatus;
  return {
    reference: lead.reference,
    version: quote.version,
    status,
    travelerName: leadContact(lead, traveler).name,
    lineItems: lineViews(quote),
    exclusions: [...quote.exclusions],
    terms: quote.terms ?? '',
    fx: {
      rate: quote.fx?.rate ?? '',
      effectiveAt: ((quote.fx?.effectiveAt as Date | undefined) ?? quote.updatedAt).toISOString(),
    },
    totals: {
      totalMinorPKR: quote.totals?.totalMinorPKR ?? 0,
      totalMinorSAR: quote.totals?.totalMinorSAR ?? 0,
    },
    sentAt: (quote.sentAt ?? quote.updatedAt).toISOString(),
    expiresAt: quote.expiresAt.toISOString(),
    acceptedAt: iso(quote.acceptedAt),
    canAccept: status === 'sent',
    viaOlderLink,
    hasNewerVersion: Boolean(quote.replacedById),
  };
}

export async function getPublicQuote(token: string, follow: boolean): Promise<PublicQuoteView> {
  const { quote, viaOlderLink } = await resolveToken(token, follow);
  return publicView(quote, viaOlderLink);
}

/** "Accept quote": records the request; it does not book anything. */
export async function acceptPublicQuote(
  token: string,
  follow: boolean,
  request: { ip?: string },
  deps: LeadsDeps,
): Promise<PublicQuoteView> {
  const { quote, viaOlderLink } = await resolveToken(token, follow);
  const cannotAccept = (status: string) =>
    new HttpError(409, `quote_${status}`, 'This quote can no longer be accepted.');
  if (quote.status === 'accepted') return publicView(quote, viaOlderLink);
  if (quote.status !== 'sent') throw cannotAccept(quote.status);
  const lead = await loadLeadOf(quote);
  const actor: Actor = { role: 'public', ip: request.ip };
  // The link this request came in on must still be the quote's link when the
  // acceptance is written (staff may renew it at this moment because the old
  // one went to the wrong person). An older link followed to the newest
  // version belongs to a replaced quote, whose link cannot be renewed.
  const viaOwnLink = { publicTokenHash: hashQuoteToken(token) };
  let alreadyAccepted = false;
  let refused = false;
  let leadDeclined = false;
  let leadMoved = false;
  let otherAccepted = false;
  let linkRenewed = false;
  const acceptedAt = new Date();
  const auditLeadMove = () =>
    recordAudit({
      actor,
      action: 'lead.status',
      entityType: 'lead',
      entityId: lead.id as string,
      before: { status: 'quote_sent' },
      after: { status: 'accepted' },
    });
  const accept = async () => {
    // MongoDB may run this more than once (a transaction that conflicted is
    // retried): every attempt starts from a clean slate, not from what an
    // abandoned attempt decided.
    alreadyAccepted = false;
    refused = false;
    leadDeclined = false;
    leadMoved = false;
    otherAccepted = false;
    linkRenewed = false;
    assertTransition(QUOTE_TRANSITIONS, 'sent', 'accepted');
    // The lead first, conditional on its stored status: it decides a race with
    // a staff decline (which also writes the lead first). If staff declined it,
    // the quote is left alone and the customer is told; if this write wins,
    // the decline finds the lead accepted and touches nothing.
    assertTransition(LEAD_TRANSITIONS, 'quote_sent', 'accepted');
    const movedLead = await LeadModel.updateOne(
      { _id: lead._id, status: 'quote_sent' },
      { $set: { status: 'accepted' } },
    );
    leadMoved = movedLead.matchedCount === 1;
    if (!leadMoved) {
      const status = await storedLeadStatus(lead._id);
      syncLeadStatus(lead, status);
      if (status === 'declined') {
        leadDeclined = true;
        return; // nothing written
      }
      // A lead is accepted through one quote only.
      if (
        status === 'accepted' &&
        (await QuoteModel.exists({
          leadId: lead._id,
          status: 'accepted',
          _id: { $ne: quote._id },
        }))
      ) {
        otherAccepted = true;
        return; // nothing written
      }
      // Lost, or already accepted through this quote (a second click): the quote decides, as before.
    }
    // Conditional on the stored state at the moment of writing: staff may send
    // a newer version (which replaces this one) or decline it, and the deadline
    // may pass, between the checks above and this write.
    const accepted = await QuoteModel.updateOne(
      {
        _id: quote._id,
        status: 'sent',
        expiresAt: { $gt: acceptedAt },
        ...(viaOlderLink ? {} : viaOwnLink),
      },
      { $set: { status: 'accepted', acceptedAt } },
    );
    if (accepted.matchedCount === 0) {
      await syncQuoteState(quote);
      linkRenewed =
        !viaOlderLink && (await QuoteModel.countDocuments({ _id: quote._id, ...viaOwnLink })) === 0;
      if (quote.status === 'accepted') {
        // A second click: harmless. (With a renewed link: accepted on the new
        // link meanwhile; this old link gets the usual 404 below.)
        alreadyAccepted = !linkRenewed;
        // If this click moved the lead and the other one accepted the quote, record the move.
        if (leadMoved) await auditLeadMove();
      } else refused = true; // handled after the transaction
      if (refused && leadMoved) {
        // Undo our own lead step (only if still ours), so lead and quote agree.
        await LeadModel.updateOne(
          { _id: lead._id, status: 'accepted' },
          { $set: { status: 'quote_sent' } },
        );
        syncLeadStatus(lead, 'quote_sent');
        leadMoved = false;
      }
      return;
    }
    quote.set({ status: 'accepted', acceptedAt });
    quote.unmarkModified('status');
    quote.unmarkModified('acceptedAt');
    await recordAudit({
      actor,
      action: 'quote.accept',
      entityType: 'quote',
      entityId: quote.id as string,
      before: { status: 'sent' },
      after: { status: 'accepted', version: quote.version },
    });
    if (leadMoved) {
      syncLeadStatus(lead, 'accepted');
      await auditLeadMove();
    }
  };
  try {
    await inTransaction(accept);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // The index refused "accepted": another quote for this lead was accepted
    // at the same moment. That acceptance stands, and with it the accepted
    // lead; this quote is left as it was. Without transactions this request
    // may be the one that moved the lead, so that move is still recorded.
    if (leadMoved && (await storedLeadStatus(lead._id)) === 'accepted') await auditLeadMove();
    otherAccepted = true;
  }
  if (otherAccepted) throw cannotAccept('other_accepted');
  if (linkRenewed) throw linkNotFound();
  if (leadDeclined) throw cannotAccept('declined');
  if (alreadyAccepted) {
    return publicView(await loadQuote(quote.id as string), viaOlderLink);
  }
  if (refused) {
    // Still "sent" here means the deadline passed before the write: expire it
    // (conditionally, outside the transaction so it is kept) and say so.
    await refreshExpiry(quote, acceptedAt);
    throw cannotAccept(quote.status);
  }
  if (deps.config.staffNotifyEmail) {
    await sendQuietly(
      deps.email,
      staffNotice(
        deps.config.staffNotifyEmail,
        'staff.quote_accepted',
        lead.reference,
        `${deps.config.publicSiteUrl}/admin/leads/${lead.id as string}`,
      ),
    );
  }
  return publicView(quote, viaOlderLink);
}

/** "Ask a question": a message to staff on the lead. */
export async function askAboutPublicQuote(
  token: string,
  follow: boolean,
  body: string,
  request: { ip?: string },
  deps: LeadsDeps,
): Promise<void> {
  const { quote } = await resolveToken(token, follow);
  const lead = await loadLeadOf(quote);
  const message = await MessageModel.create({
    leadId: lead._id,
    direction: 'inbound',
    channel: 'site',
    body,
    quoteId: quote._id,
  });
  await recordAudit({
    actor: { role: 'public', ip: request.ip },
    action: 'message.create',
    entityType: 'message',
    entityId: message.id as string,
    after: {
      leadReference: lead.reference,
      direction: 'inbound',
      channel: 'site',
      version: quote.version,
    },
  });
  if (deps.config.staffNotifyEmail) {
    await sendQuietly(
      deps.email,
      staffNotice(
        deps.config.staffNotifyEmail,
        'staff.question',
        lead.reference,
        `${deps.config.publicSiteUrl}/admin/leads/${lead.id as string}`,
      ),
    );
  }
}
