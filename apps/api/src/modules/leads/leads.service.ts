/**
 * Inquiries and the lead pipeline (docs/01 section 5).
 * new -> contacted -> quote_in_progress -> quote_sent -> accepted | declined | lost.
 * There is no "confirmed" or "booked" status in v1 (owner's decision).
 */
import { createHash } from 'node:crypto';
import {
  LEAD_TRANSITIONS,
  StatusTransitionError,
  assertTransition,
  formatPkMobile,
  type Assignee,
  type CalculationResult,
  type InquiryData,
  type InquiryResponse,
  type LeadDetail,
  type LeadListQuery,
  type LeadStatus,
  type LeadSummary,
  type MessageView,
  type Paged,
  type QuoteSummary,
  type Role,
  type UpdateLeadBody,
} from '@marafiq/shared';
import mongoose, { type Types } from 'mongoose';
import type { EmailAdapter } from '../../adapters/email/email.js';
import type { AppConfig } from '../../config/app-config.js';
import { HttpError, notFound } from '../../lib/http-error.js';
import { inTransaction } from '../../lib/transaction.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { canonicalJson } from '../pricing/engine.js';
import {
  calculateNow,
  getCalculation,
  saveCalculation,
  todayInPakistan,
} from '../pricing/pricing.service.js';
import { getSettings } from '../settings/settings.service.js';
import { UserModel } from '../users/user.model.js';
import { inquiryAck, sendQuietly, staffNotice } from './emails.js';
import {
  CounterModel,
  LeadModel,
  MessageModel,
  QuoteModel,
  TravelerModel,
  leadContact,
  type LeadDoc,
} from './lead.models.js';

export interface LeadsDeps {
  email: EmailAdapter;
  config: Pick<AppConfig, 'publicSiteUrl' | 'staffNotifyEmail'>;
}

const DAY_MS = 24 * 3_600_000;
const id = (value: unknown) => String(value);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);

/** Only admins and sales manage leads; ops and finance read (docs/02 section 3). */
export const LEAD_READERS = ['admin', 'sales', 'ops', 'finance'] as const;
export const LEAD_MANAGERS = ['admin', 'sales'] as const;
/** Roles that may see quotes (ops may not). */
export const QUOTE_READERS: readonly Role[] = ['admin', 'sales', 'finance'];

/** The normal forward path; the pipeline walks it one audited step at a time. */
const FORWARD: LeadStatus[] = ['new', 'contacted', 'quote_in_progress', 'quote_sent'];

/** Statuses in which a lead can still get a quote (anything else is closed). */
export const OPEN_LEAD_STATUSES: readonly LeadStatus[] = FORWARD;
export const leadClosed = () => new HttpError(409, 'lead_closed', 'This lead is closed.');

export const transitionError = (from: string, to: string) =>
  new HttpError(409, 'invalid_transition', `A lead cannot go from "${from}" to "${to}".`);

/** Someone else changed the lead's status between our read and our write. */
export const leadChanged = (current: string) =>
  new HttpError(
    409,
    'lead_changed',
    'This lead was changed by someone else at the same time. Reload it and try again.',
    { status: current },
  );

/** Keep an in-memory lead in step with a status already stored (nothing to write back). */
export function syncLeadStatus(lead: LeadDoc, status: string): void {
  lead.set('status', status);
  lead.unmarkModified('status');
}

/** The lead's stored status now, for deciding after a conditional write did not match. */
export async function storedLeadStatus(leadId: unknown): Promise<LeadStatus> {
  const current = await LeadModel.findById(leadId).select('status').lean();
  if (!current) throw notFound('Lead');
  return current.status as LeadStatus;
}

/**
 * Move a lead forward to `target` (e.g. building a quote moves a new lead to
 * quote_in_progress), one allowed step at a time, auditing each step. Does
 * nothing if the lead is already there or further on.
 *
 * Every step is conditional on the status it starts from, so a status someone
 * else stored meanwhile (lost, declined, accepted) is never overwritten: on a
 * mismatch the stored status is read again and the walk continues from there,
 * or stops with lead_closed if the lead is now closed.
 */
export async function advanceLead(lead: LeadDoc, target: LeadStatus, actor: Actor): Promise<void> {
  const to = FORWARD.indexOf(target);
  for (let attempt = 0; attempt < FORWARD.length * 2; attempt += 1) {
    const before = lead.status as LeadStatus;
    const from = FORWARD.indexOf(before);
    if (from < 0) throw leadClosed();
    if (from >= to) return;
    const next = FORWARD[from + 1] as LeadStatus;
    assertTransition(LEAD_TRANSITIONS, before, next);
    const moved = await LeadModel.updateOne(
      { _id: lead._id, status: before },
      { $set: { status: next } },
    );
    if (moved.matchedCount === 0) {
      syncLeadStatus(lead, await storedLeadStatus(lead._id));
      continue;
    }
    syncLeadStatus(lead, next);
    await recordAudit({
      actor,
      action: 'lead.status',
      entityType: 'lead',
      entityId: lead.id as string,
      before: { status: before },
      after: { status: next },
    });
  }
  throw leadChanged(lead.status);
}

/** MSF-YYYY-NNNNNN, numbered per year (Pakistan time). */
export async function nextReference(now: Date = new Date()): Promise<string> {
  const year = todayInPakistan(now).slice(0, 4);
  const key = `lead-${year}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const counter = await CounterModel.findOneAndUpdate(
        { _id: key },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      return `MSF-${year}-${String(counter?.seq ?? 0).padStart(6, '0')}`;
    } catch (error) {
      // Two first-of-the-year inquiries can race to create the counter; retry once.
      if (attempt === 0 && (error as { code?: number }).code === 11000) continue;
      throw error;
    }
  }
}

function adminLeadLink(config: LeadsDeps['config'], leadId: string): string {
  return `${config.publicSiteUrl}/admin/leads/${leadId}`;
}

/** POST /public/inquiries (docs/01 section 5, steps 1-2). */
export async function createInquiry(
  body: InquiryData,
  request: { ip?: string },
  deps: LeadsDeps,
  now: Date = new Date(),
): Promise<InquiryResponse> {
  const settings = await getSettings();
  const responseTimeText = settings.responseTimeText;

  // Price the trip again on the server; the browser's numbers are never trusted.
  let calculation: CalculationResult | null = null;
  if (body.inputs) {
    try {
      calculation = await calculateNow(body.inputs, now);
    } catch (error) {
      // No FX rate yet: keep the inquiry and the trip; staff price it by hand.
      if (!(error instanceof HttpError && error.code === 'prices_unavailable')) throw error;
    }
  }

  const trip = calculation
    ? `calc:${calculation.hash}`
    : body.inputs
      ? `inputs:${sha256(canonicalJson(body.inputs))}`
      : `none:${body.source}`;
  const dedupeKey = sha256(`${body.traveler.phone}|${trip}`);

  const recent = await LeadModel.findOne({
    dedupeKey,
    createdAt: { $gte: new Date(now.getTime() - DAY_MS) },
  })
    .sort({ createdAt: -1 })
    .select('reference')
    .lean();
  if (recent) return { reference: recent.reference, duplicate: true, responseTimeText };

  const { lead } = await inTransaction(async () => {
    const traveler = await TravelerModel.findOneAndUpdate(
      { phone: body.traveler.phone },
      {
        $set: {
          name: body.traveler.name,
          language: body.traveler.language,
          ...(body.traveler.email ? { email: body.traveler.email } : {}),
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    const calculationId = calculation ? await saveCalculation(calculation) : null;
    const reference = await nextReference(now);
    const lead = await LeadModel.create({
      reference,
      travelerId: traveler._id,
      // Snapshot for this lead only; see leadContact().
      contact: {
        name: body.traveler.name,
        email: body.traveler.email ?? null,
        language: body.traveler.language,
      },
      calculationId,
      tripInputs: body.inputs ?? null,
      source: body.source,
      status: 'new',
      notesText: body.notes,
      consent: { textVersion: body.consent.textVersion, acceptedAt: now, ip: request.ip },
      dedupeKey,
    });
    // No name, phone or email in audit data.
    await recordAudit({
      actor: { role: 'public', ip: request.ip },
      action: 'lead.create',
      entityType: 'lead',
      entityId: lead.id as string,
      after: { reference, source: body.source, calculated: calculation !== null },
    });
    return { lead, traveler };
  });

  if (body.traveler.email) {
    await sendQuietly(
      deps.email,
      inquiryAck(body.traveler.email, body.traveler.language, lead.reference, responseTimeText),
    );
  }
  if (deps.config.staffNotifyEmail) {
    await sendQuietly(
      deps.email,
      staffNotice(
        deps.config.staffNotifyEmail,
        'staff.new_inquiry',
        lead.reference,
        adminLeadLink(deps.config, lead.id as string),
      ),
    );
  }
  return { reference: lead.reference, duplicate: false, responseTimeText };
}

// --- Admin views -------------------------------------------------------------

async function userNames(ids: (Types.ObjectId | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean).map(id))];
  if (wanted.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: wanted } })
    .select('name')
    .lean();
  return new Map(users.map((u) => [id(u._id), u.name]));
}

export function quoteSummary(q: {
  _id: unknown;
  version: number;
  status: string;
  totals?: { totalMinorPKR?: number; totalMinorSAR?: number } | null;
  expiresAt: Date;
  sentAt?: Date | null;
  acceptedAt?: Date | null;
}): QuoteSummary {
  return {
    id: id(q._id),
    version: q.version,
    status: q.status as QuoteSummary['status'],
    totalMinorPKR: q.totals?.totalMinorPKR ?? 0,
    totalMinorSAR: q.totals?.totalMinorSAR ?? 0,
    expiresAt: q.expiresAt.toISOString(),
    sentAt: iso(q.sentAt),
    acceptedAt: iso(q.acceptedAt),
  };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listLeads(
  query: LeadListQuery,
  me: string,
  role: Role,
): Promise<Paged<LeadSummary>> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.assigned === 'me') filter.assignedTo = new mongoose.Types.ObjectId(me);
  else if (query.assigned === 'unassigned') filter.assignedTo = null;
  else if (query.assigned) filter.assignedTo = new mongoose.Types.ObjectId(query.assigned);

  if (query.q) {
    const text = query.q.trim();
    const digits = text.replace(/\D/g, '');
    const or: Record<string, unknown>[] = [
      { reference: { $regex: escapeRegex(text.toUpperCase()) } },
    ];
    const travelerOr: Record<string, unknown>[] = [
      { name: { $regex: escapeRegex(text), $options: 'i' } },
    ];
    if (digits.length >= 4)
      travelerOr.push({ phone: { $regex: escapeRegex(digits.replace(/^0/, '')) } });
    const travelers = await TravelerModel.find({ $or: travelerOr }).select('_id').limit(500).lean();
    if (travelers.length) or.push({ travelerId: { $in: travelers.map((t) => t._id) } });
    or.push({ 'contact.name': { $regex: escapeRegex(text), $options: 'i' } });
    filter.$or = or;
  }

  const [total, leads] = await Promise.all([
    LeadModel.countDocuments(filter),
    LeadModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
  ]);
  const [travelers, names, quotes] = await Promise.all([
    TravelerModel.find({ _id: { $in: leads.map((l) => l.travelerId) } }).lean(),
    userNames(leads.map((l) => l.assignedTo)),
    // Ops may not see quotes (decision 133), not even their status in the list.
    canSeeQuotes(role)
      ? QuoteModel.find({ leadId: { $in: leads.map((l) => l._id) } })
          .select('leadId version status')
          .sort({ version: -1 })
          .lean()
      : Promise.resolve([]),
  ]);

  const items = leads.map((lead): LeadSummary => {
    const traveler = travelers.find((t) => id(t._id) === id(lead.travelerId));
    const latest = quotes.find((q) => id(q.leadId) === id(lead._id));
    return {
      id: id(lead._id),
      reference: lead.reference,
      status: lead.status as LeadStatus,
      source: lead.source as LeadSummary['source'],
      travelerName: leadContact(lead, traveler).name,
      phone: traveler ? formatPkMobile(traveler.phone) : '',
      assignedTo: lead.assignedTo
        ? { id: id(lead.assignedTo), name: names.get(id(lead.assignedTo)) ?? '' }
        : null,
      createdAt: lead.createdAt.toISOString(),
      latestQuote: latest
        ? {
            id: id(latest._id),
            version: latest.version,
            status: latest.status as QuoteSummary['status'],
          }
        : null,
    };
  });
  return { items, page: query.page, limit: query.limit, total };
}

async function loadLead(leadId: string): Promise<LeadDoc> {
  const lead = mongoose.isValidObjectId(leadId) ? await LeadModel.findById(leadId) : null;
  if (!lead) throw notFound('Lead');
  return lead;
}

export async function getLeadDetail(leadId: string, role: Role): Promise<LeadDetail> {
  const lead = await loadLead(leadId);
  const [traveler, messages, quotes] = await Promise.all([
    TravelerModel.findById(lead.travelerId).lean(),
    MessageModel.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean(),
    canSeeQuotes(role)
      ? QuoteModel.find({ leadId: lead._id }).sort({ version: -1 }).lean()
      : Promise.resolve(null),
  ]);
  if (!traveler) throw notFound('Traveler');
  const names = await userNames([
    lead.assignedTo,
    ...lead.notes.map((n) => n.by),
    ...messages.map((m) => m.by),
  ]);
  let calculation: CalculationResult | null = null;
  if (lead.calculationId) calculation = await getCalculation(id(lead.calculationId));

  const latest = quotes?.[0];
  const contact = leadContact(lead, traveler);
  return {
    id: lead.id as string,
    reference: lead.reference,
    status: lead.status as LeadStatus,
    source: lead.source as LeadSummary['source'],
    travelerName: contact.name,
    phone: formatPkMobile(traveler.phone),
    assignedTo: lead.assignedTo
      ? { id: id(lead.assignedTo), name: names.get(id(lead.assignedTo)) ?? '' }
      : null,
    createdAt: lead.createdAt.toISOString(),
    latestQuote: latest
      ? {
          id: id(latest._id),
          version: latest.version,
          status: latest.status as QuoteSummary['status'],
        }
      : null,
    // This inquiry's details, so staff see where this lead's quote will go.
    traveler: { ...contact, phone: formatPkMobile(traveler.phone) },
    notesText: lead.notesText ?? '',
    consent: {
      textVersion: lead.consent?.textVersion ?? '',
      acceptedAt: (lead.consent?.acceptedAt ?? lead.createdAt).toISOString(),
    },
    tripInputs: (lead.tripInputs as LeadDetail['tripInputs']) ?? null,
    calculation,
    notes: lead.notes.map((n) => ({
      body: n.body,
      by: names.get(id(n.by)) ?? '',
      at: n.at.toISOString(),
    })),
    messages: messages.map((m): MessageView => ({
      id: id(m._id),
      direction: m.direction as MessageView['direction'],
      channel: m.channel as MessageView['channel'],
      body: m.body,
      byName: m.by ? (names.get(id(m.by)) ?? '') : null,
      createdAt: m.createdAt.toISOString(),
    })),
    ...(quotes ? { quotes: quotes.map(quoteSummary) } : {}),
    nextStatuses: [...LEAD_TRANSITIONS[lead.status as LeadStatus]],
  };
}

function canSeeQuotes(role: Role): boolean {
  return QUOTE_READERS.includes(role);
}

export async function listAssignees(): Promise<Assignee[]> {
  const users = await UserModel.find({ active: true, role: { $in: LEAD_MANAGERS } })
    .select('name role')
    .sort({ name: 1 })
    .lean();
  return users.map((u) => ({ id: id(u._id), name: u.name, role: u.role as Role }));
}

export async function updateLead(
  leadId: string,
  body: UpdateLeadBody,
  actor: Actor,
): Promise<void> {
  const lead = await loadLead(leadId);
  const from = lead.status as LeadStatus;
  const before = { status: from, assignedTo: lead.assignedTo ? id(lead.assignedTo) : null };

  let assignedTo: mongoose.Types.ObjectId | null | undefined;
  if (body.assignedTo !== undefined) {
    if (body.assignedTo !== null) {
      const user = await UserModel.findOne({
        _id: body.assignedTo,
        active: true,
        role: { $in: LEAD_MANAGERS },
      }).lean();
      if (!user) {
        throw new HttpError(400, 'validation_error', 'Please check the highlighted fields', {
          assignedTo: 'Choose an active admin or sales user',
        });
      }
    }
    assignedTo = body.assignedTo === null ? null : new mongoose.Types.ObjectId(body.assignedTo);
  }

  const changesStatus = body.status !== undefined && body.status !== from;
  if (changesStatus) {
    try {
      assertTransition(LEAD_TRANSITIONS, from, body.status as LeadStatus);
    } catch (error) {
      if (error instanceof StatusTransitionError) throw transitionError(error.from, error.to);
      throw error;
    }
  }

  await inTransaction(async () => {
    // The lead is written first, and a status change only if the stored status
    // is still the one this decision was made from: a customer acceptance or
    // another staff change stored meanwhile is never overwritten. On a mismatch
    // nothing is written (no quote either) and staff get a conflict to reload.
    const set: Record<string, unknown> = {};
    if (changesStatus) set.status = body.status;
    if (assignedTo !== undefined) set.assignedTo = assignedTo;
    let after = { status: from as string, assignedTo: before.assignedTo };
    if (Object.keys(set).length > 0) {
      const updated = await LeadModel.findOneAndUpdate(
        changesStatus ? { _id: lead._id, status: from } : { _id: lead._id },
        { $set: set },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) throw leadChanged(await storedLeadStatus(lead._id));
      after = {
        status: updated.status,
        assignedTo: updated.assignedTo ? id(updated.assignedTo) : null,
      };
    }
    if (changesStatus) {
      // A declined lead declines the quote the customer is looking at.
      if (body.status === 'declined') {
        // Each write is conditional on the stored status: the customer may accept
        // at this very moment (without a transaction nothing else would stop it),
        // and an accepted quote must stay accepted. Only changed quotes are audited.
        const open = await QuoteModel.find({ leadId: lead._id, status: 'sent' }, { _id: 1 });
        for (const quote of open) {
          const declined = await QuoteModel.updateOne(
            { _id: quote._id, status: 'sent' },
            { $set: { status: 'declined' } },
          );
          if (declined.matchedCount === 0) continue; // accepted (or expired) meanwhile
          await recordAudit({
            actor,
            action: 'quote.decline',
            entityType: 'quote',
            entityId: quote.id as string,
            before: { status: 'sent' },
            after: { status: 'declined' },
          });
        }
      }
    }
    await recordAudit({
      actor,
      action: 'lead.update',
      entityType: 'lead',
      entityId: lead.id as string,
      before,
      after,
    });
  });
}

export async function addLeadNote(leadId: string, body: string, actor: Actor): Promise<void> {
  const lead = await loadLead(leadId);
  lead.notes.push({ body, by: new mongoose.Types.ObjectId(actor.id), at: new Date() });
  await lead.save();
  await recordAudit({
    actor,
    action: 'lead.note',
    entityType: 'lead',
    entityId: lead.id as string,
    after: { notes: lead.notes.length },
  });
}

/** Log a reply staff sent by email or WhatsApp outside the site. */
export async function addLeadMessage(
  leadId: string,
  input: { body: string; channel: 'email' | 'whatsapp_manual' },
  actor: Actor,
): Promise<void> {
  const lead = await loadLead(leadId);
  const message = await MessageModel.create({
    leadId: lead._id,
    direction: 'outbound',
    channel: input.channel,
    body: input.body,
    by: actor.id,
  });
  await recordAudit({
    actor,
    action: 'message.create',
    entityType: 'message',
    entityId: message.id as string,
    after: { leadReference: lead.reference, direction: 'outbound', channel: input.channel },
  });
}
