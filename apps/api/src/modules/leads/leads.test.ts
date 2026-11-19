/**
 * Inquiries, the lead pipeline and quotes, end to end through the API
 * (docs/01 sections 5-7). The WMT sheet is published so inquiries are priced.
 */
import {
  CONSENT_TEXT_VERSION,
  CUSTOMER_QUOTE_STATUS_WORDING,
  type CalculateInputBody,
} from '@marafiq/shared';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryEmail } from '../../adapters/email/email.js';
import { MemoryStorage } from '../../adapters/storage/storage.js';
import { createApp } from '../../app.js';
import {
  CookieJar,
  FixtureExtraction,
  seedSheetHotels,
  seedSupplier,
  seedUser,
  signInAs,
  testConfig,
  uploadAndExtract,
} from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { HotelModel } from '../hotels/hotel.model.js';
import { CalculationModel } from '../pricing/calculation.model.js';
import { LeadModel, MessageModel, QuoteModel, TravelerModel } from './lead.models.js';

const PUBLIC = '/api/v1/public';
const ADMIN = '/api/v1/admin';
const LINK = /^https:\/\/site\.test\/q\/([A-Za-z0-9_-]{43})$/;

let app: Express;
let email: MemoryEmail;
let ops: CookieJar;
let admin: CookieJar;
let sales: CookieJar;
let salesId: string;
let tripInputs: CalculateInputBody;

const hotelId = async (name: string) =>
  String((await HotelModel.findOne({ canonicalName: name }).lean())?._id);

async function publishWmt() {
  const supplier = await seedSupplier({ name: 'Waqar-e-Madina Group (WMT)' });
  await seedSheetHotels();
  const doc = await uploadAndExtract(app, ops, supplier.id);
  for (const pack of doc.packages) {
    const res = await request(app)
      .post(`${ADMIN}/rate-packages/${pack.id}/publish`)
      .set('Cookie', ops.header())
      .send({ acknowledgeWarnings: true });
    expect(res.status).toBe(200);
  }
}

async function setFx(rate = '75.00') {
  expect(
    (await request(app).post(`${ADMIN}/fx`).set('Cookie', admin.header()).send({ rate })).status,
  ).toBe(201);
}

function inquiry(overrides: Record<string, unknown> = {}) {
  return {
    source: 'umrah',
    traveler: {
      name: 'Aisha Khan',
      phone: '0300 1234567',
      email: 'aisha@example.com',
      language: 'ur',
    },
    notes: 'Prefer a lower floor',
    consent: { accepted: true, textVersion: CONSENT_TEXT_VERSION },
    inputs: tripInputs,
    ...overrides,
  };
}

const submit = (body: object, ip = '203.0.113.7') =>
  request(app).post(`${PUBLIC}/inquiries`).set('X-Forwarded-For', ip).send(body);

async function leadByReference(reference: string) {
  const lead = await LeadModel.findOne({ reference }).lean();
  if (!lead) throw new Error(`no lead ${reference}`);
  return String(lead._id);
}

/** Inquiry -> draft quote -> sent. Returns ids and the customer's token. */
async function sentQuote() {
  const { reference } = (await submit(inquiry())).body;
  const leadId = await leadByReference(reference);
  const draft = await request(app)
    .post(`${ADMIN}/leads/${leadId}/quotes`)
    .set('Cookie', sales.header());
  expect(draft.status).toBe(201);
  const sent = await request(app)
    .post(`${ADMIN}/quotes/${draft.body.id}/send`)
    .set('Cookie', sales.header());
  expect(sent.status).toBe(200);
  const token = LINK.exec(sent.body.link)?.[1] as string;
  return { reference, leadId, quoteId: draft.body.id as string, token };
}

/** A single-server MongoDB has no transactions: run the next writes the same way. */
function withoutTransactions() {
  vi.spyOn(mongoose.connection, 'transaction').mockImplementation((async (
    work: () => Promise<unknown>,
  ) => {
    await work();
  }) as unknown as typeof mongoose.connection.transaction);
}

/** Run `after` right after the first query of `model.method` matching `matches` has read. */
function afterRead(
  model: object,
  method: 'findById' | 'findOne' | 'find',
  matches: (args: unknown[]) => boolean,
  after: (stale: { _id?: unknown } | null) => Promise<void>,
): { injected: () => boolean } {
  const target = model as Record<typeof method, (...args: unknown[]) => unknown>;
  const original = target[method].bind(model);
  let injected = false;
  vi.spyOn(target, method).mockImplementation(((...args: unknown[]) => {
    const query = original(...args) as PromiseLike<{ _id?: unknown } | null>;
    if (injected || !matches(args)) return query;
    injected = true;
    return Promise.resolve(query).then(async (stale) => {
      await after(stale);
      return stale; // the caller still holds what it read before `after`
    });
  }) as never);
  return { injected: () => injected };
}

beforeEach(async () => {
  email = new MemoryEmail();
  app = createApp({
    config: testConfig({ staffNotifyEmail: 'staff@agency.test' }),
    deps: {
      storage: new MemoryStorage(),
      extraction: new FixtureExtraction(),
      inlineJobs: true,
      email,
    },
  });
  ops = await signInAs(app, await seedUser({ role: 'ops' }));
  admin = await signInAs(app, await seedUser({ role: 'admin' }));
  const salesUser = await seedUser({ role: 'sales', name: 'Bilal Sales' });
  salesId = salesUser.id;
  sales = await signInAs(app, salesUser);
  await setFx();
  await publishWmt();
  tripInputs = {
    departureCity: 'Islamabad',
    arrivalDate: '2027-02-08',
    nightsMakkah: 3,
    nightsMadinah: 2,
    order: 'makkah_first',
    travelers: { adults: 4 },
    rooms: [{ occupancy: 'quad', persons: 4 }],
    hotels: {
      makkah: await hotelId('Qila Ajiyad'),
      madinah: await hotelId('Waqar Salmiya/Jood Marjan'),
    },
    visa: 'direct',
    flight: 'self',
  };
});

describe('POST /public/inquiries', () => {
  it('creates a lead with a reference, the consent version and a server-side snapshot', async () => {
    const res = await submit(inquiry({ totals: { groupMinorPKR: 1 } }));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      reference: expect.stringMatching(/^MSF-\d{4}-000001$/),
      duplicate: false,
      responseTimeText: expect.any(String),
    });

    const lead = await LeadModel.findOne({ reference: res.body.reference }).lean();
    expect(lead).toMatchObject({
      status: 'new',
      source: 'umrah',
      notesText: 'Prefer a lower floor',
    });
    expect(lead?.consent).toMatchObject({ textVersion: CONSENT_TEXT_VERSION, ip: '203.0.113.7' });
    // The server priced the trip itself: T1 with own flights is SAR 3,232.
    const calc = await CalculationModel.findById(lead?.calculationId).lean();
    expect(calc?.totals).toMatchObject({ groupMinorSAR: 323_200, groupMinorPKR: 24_240_000 });
    expect(await TravelerModel.findOne({ phone: '+923001234567' }).lean()).toMatchObject({
      name: 'Aisha Khan',
      email: 'aisha@example.com',
      language: 'ur',
    });

    const second = await submit(
      inquiry({ traveler: { name: 'Omar', phone: '0321 7654321', language: 'en' } }),
    );
    expect(second.body.reference).toMatch(/-000002$/);
  });

  it('returns the same reference for the same phone and trip within 24 hours', async () => {
    const first = await submit(inquiry());
    const again = await submit(
      inquiry({ traveler: { name: 'Aisha K', phone: '+92 300 1234567', language: 'ur' } }),
    );
    expect(again.body).toMatchObject({ reference: first.body.reference, duplicate: true });
    expect(await LeadModel.countDocuments()).toBe(1);

    // A different trip is a new inquiry.
    const other = await submit(inquiry({ inputs: { ...tripInputs, nightsMadinah: 3 } }));
    expect(other.body.duplicate).toBe(false);

    // After 24 hours the same trip is new again.
    // createdAt is immutable in Mongoose, so move it with the driver.
    await LeadModel.collection.updateOne(
      { reference: first.body.reference },
      { $set: { createdAt: new Date(Date.now() - 25 * 3_600_000) } },
    );
    const later = await submit(inquiry());
    expect(later.body).toMatchObject({ duplicate: false });
    expect(later.body.reference).not.toBe(first.body.reference);
  });

  describe('the same inquiry sent several times at the same moment (double tap)', () => {
    async function sendTogether() {
      const replies = await Promise.all([1, 2, 3].map(() => submit(inquiry())));
      expect(replies.map((r) => r.status)).toEqual([201, 201, 201]);
      const references = new Set(replies.map((r) => r.body.reference));
      expect(references.size).toBe(1);
      expect(replies.filter((r) => r.body.duplicate === false)).toHaveLength(1);
      expect(await LeadModel.countDocuments()).toBe(1);
      // One acknowledgement and one staff notice, not three of each.
      expect(email.sent.filter((m) => m.kind === 'inquiry.ack')).toHaveLength(1);
      expect(email.sent.filter((m) => m.kind === 'staff.new_inquiry')).toHaveLength(1);
    }

    it('stores one lead and gives every reply its reference (with transactions)', async () => {
      await sendTogether();
    });

    it('stores one lead without transactions too (a single server)', async () => {
      withoutTransactions();
      await sendTogether();
    });

    it('keeps no phone number in the claim, only the hashed key', async () => {
      await submit(inquiry());
      const claims = await mongoose.connection.collection('inquiryClaims').find().toArray();
      expect(claims).toHaveLength(1);
      expect(String(claims[0]?._id)).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(claims)).not.toMatch(/300|1234567/);
    });

    it('a failed attempt does not block the traveler from sending again', async () => {
      withoutTransactions();
      vi.spyOn(LeadModel, 'create').mockRejectedValueOnce(new Error('disk full'));
      const failed = await submit(inquiry());
      expect(failed.status).toBe(500);
      vi.restoreAllMocks();
      const retry = await submit(inquiry());
      expect(retry.status).toBe(201);
      expect(retry.body.duplicate).toBe(false);
      expect(await LeadModel.countDocuments()).toBe(1);
    });

    it('a claim with no lead behind it does not block a new inquiry', async () => {
      const first = await submit(inquiry());
      await LeadModel.deleteMany({}); // e.g. a crash after the claim on a single server
      const again = await submit(inquiry());
      expect(again.status).toBe(201);
      expect(again.body.duplicate).toBe(false);
      expect(again.body.reference).not.toBe(first.body.reference);
    });
  });

  it('accepts an inquiry without a trip (from the Hotels page)', async () => {
    const res = await submit(inquiry({ source: 'hotels', inputs: undefined }));
    expect(res.status).toBe(201);
    const lead = await LeadModel.findOne({ reference: res.body.reference }).lean();
    expect(lead).toMatchObject({ source: 'hotels', calculationId: null, tripInputs: null });
  });

  it('keeps the trip when it cannot be priced yet (no FX rate)', async () => {
    const { FxRateModel } = await import('../fx/fx.model.js');
    await FxRateModel.deleteMany({});
    const res = await submit(inquiry());
    expect(res.status).toBe(201);
    const lead = await LeadModel.findOne({ reference: res.body.reference }).lean();
    expect(lead?.calculationId).toBeNull();
    expect(lead?.tripInputs).toMatchObject({ arrivalDate: '2027-02-08', nightsMakkah: 3 });
  });

  it('checks the phone, consent and consent version', async () => {
    const phone = await submit(
      inquiry({ traveler: { name: 'A', phone: '042 1234567', language: 'en' } }),
    );
    expect(phone.status).toBe(400);
    expect(phone.body.error.fields['traveler.phone']).toMatch(/Pakistani mobile/);
    const noConsent = await submit(
      inquiry({ consent: { accepted: false, textVersion: CONSENT_TEXT_VERSION } }),
    );
    expect(noConsent.status).toBe(400);
    const oldText = await submit(inquiry({ consent: { accepted: true, textVersion: '2020-01' } }));
    expect(oldText.status).toBe(400);
    expect(await LeadModel.countDocuments()).toBe(0);
  });

  it('never stores passport, CNIC or card numbers sent by mistake', async () => {
    const res = await submit(
      inquiry({
        passportNumber: 'AB1234567',
        traveler: {
          name: 'Aisha',
          phone: '03001234567',
          language: 'en',
          cnic: '12345-1234567-1',
          card: '4111111111111111',
        },
      }),
    );
    expect(res.status).toBe(201);
    const stored = JSON.stringify([
      await LeadModel.find().lean(),
      await TravelerModel.find().lean(),
      await AuditEventModel.find().lean(),
    ]);
    expect(stored).not.toMatch(/AB1234567|12345-1234567-1|4111111111111111/);
  });

  it('emails the customer in their language and tells staff, without personal data in the audit log', async () => {
    const res = await submit(inquiry());
    expect(email.sent.map((m) => [m.kind, m.to])).toEqual([
      ['inquiry.ack', 'aisha@example.com'],
      ['staff.new_inquiry', 'staff@agency.test'],
    ]);
    expect(email.sent[0]?.subject).toContain(res.body.reference);
    expect(email.sent[0]?.text).toContain('السلام علیکم');
    expect(email.sent[1]?.text).not.toMatch(/Aisha|1234567|aisha@example/);

    const audit = JSON.stringify(await AuditEventModel.find({ entityType: 'lead' }).lean());
    expect(audit).toContain(res.body.reference);
    expect(audit).not.toMatch(/Aisha|1234567|aisha@example/);
  });

  it('still records the inquiry when email fails', async () => {
    email.failing = true;
    const res = await submit(inquiry());
    expect(res.status).toBe(201);
    expect(await LeadModel.countDocuments()).toBe(1);
  });
});

describe('lead pipeline', () => {
  it('lists, filters and searches leads; ops and finance can read', async () => {
    const a = (await submit(inquiry())).body.reference;
    await submit(
      inquiry({
        source: 'visa',
        inputs: undefined,
        traveler: { name: 'Omar Farooq', phone: '0321 7654321', language: 'en' },
      }),
    );

    const all = await request(app).get(`${ADMIN}/leads`).set('Cookie', ops.header());
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items[0]).toMatchObject({
      travelerName: 'Omar Farooq',
      phone: '0321 7654321',
      status: 'new',
    });

    const search = (q: string) =>
      request(app)
        .get(`${ADMIN}/leads`)
        .query({ q })
        .set('Cookie', sales.header())
        .then((r) => r.body.items.map((l: { reference: string }) => l.reference));
    expect(await search(a)).toEqual([a]);
    expect(await search('0300 1234567')).toEqual([a]);
    expect(await search('aisha')).toEqual([a]);

    const finance = await signInAs(app, await seedUser({ role: 'finance' }));
    expect(
      (
        await request(app)
          .get(`${ADMIN}/leads`)
          .query({ status: 'new' })
          .set('Cookie', finance.header())
      ).body.total,
    ).toBe(2);
  });

  it('moves only along the allowed path, records each change, and assigns to sales or admin', async () => {
    const leadId = await leadByReference((await submit(inquiry())).body.reference);
    const patch = (body: object, jar = sales) =>
      request(app).patch(`${ADMIN}/leads/${leadId}`).set('Cookie', jar.header()).send(body);

    const skip = await patch({ status: 'accepted' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('invalid_transition');

    const ok = await patch({ status: 'contacted', assignedTo: salesId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'contacted',
      assignedTo: { id: salesId, name: 'Bilal Sales' },
    });
    expect(ok.body.nextStatuses).toEqual(['quote_in_progress', 'lost']);

    const opsUser = await seedUser({ role: 'ops' });
    const badAssign = await patch({ assignedTo: opsUser.id });
    expect(badAssign.status).toBe(400);
    expect(badAssign.body.error.fields.assignedTo).toBeDefined();

    const mine = await request(app)
      .get(`${ADMIN}/leads`)
      .query({ assigned: 'me' })
      .set('Cookie', sales.header());
    expect(mine.body.total).toBe(1);

    const audit = await AuditEventModel.find({ entityType: 'lead', action: 'lead.update' }).lean();
    expect(audit.at(-1)).toMatchObject({
      before: { status: 'new' },
      after: { status: 'contacted', assignedTo: salesId },
    });
  });

  it('keeps notes and logged replies on the lead; ops does not see quotes', async () => {
    const leadId = await leadByReference((await submit(inquiry())).body.reference);
    await request(app)
      .post(`${ADMIN}/leads/${leadId}/notes`)
      .set('Cookie', sales.header())
      .send({ body: 'Called, no answer' });
    const res = await request(app)
      .post(`${ADMIN}/leads/${leadId}/messages`)
      .set('Cookie', sales.header())
      .send({ body: 'Sent hotel options', channel: 'whatsapp_manual' });
    expect(res.status).toBe(201);
    expect(res.body.notes).toEqual([
      { body: 'Called, no answer', by: 'Bilal Sales', at: expect.any(String) },
    ]);
    expect(res.body.messages[0]).toMatchObject({
      direction: 'outbound',
      channel: 'whatsapp_manual',
      byName: 'Bilal Sales',
    });
    expect(res.body.quotes).toEqual([]);
    expect(res.body.calculation.totals.groupMinorSAR).toBe(323_200);

    const asOps = await request(app).get(`${ADMIN}/leads/${leadId}`).set('Cookie', ops.header());
    expect(asOps.body.quotes).toBeUndefined();
  });
});

describe('quotes', () => {
  it('ops sees no quote information on leads, in the list or the detail', async () => {
    const { leadId, quoteId } = await sentQuote();
    const finance = await signInAs(app, await seedUser({ role: 'finance' }));
    for (const reader of [sales, finance]) {
      const list = await request(app).get(`${ADMIN}/leads`).set('Cookie', reader.header());
      expect(list.body.items[0].latestQuote).toMatchObject({ id: quoteId, status: 'sent' });
    }
    const list = await request(app).get(`${ADMIN}/leads`).set('Cookie', ops.header());
    expect(list.status).toBe(200);
    expect(list.body.items[0].latestQuote).toBeNull();
    expect(JSON.stringify(list.body)).not.toContain(quoteId);
    const detail = await request(app).get(`${ADMIN}/leads/${leadId}`).set('Cookie', ops.header());
    expect(detail.body.latestQuote).toBeNull();
    expect(JSON.stringify(detail.body)).not.toContain(quoteId);
  });

  it('starts a draft from the calculation and moves the lead to quote_in_progress', async () => {
    const leadId = await leadByReference((await submit(inquiry())).body.reference);
    const res = await request(app)
      .post(`${ADMIN}/leads/${leadId}/quotes`)
      .set('Cookie', sales.header());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      version: 1,
      status: 'draft',
      totals: { totalMinorSAR: 323_200, totalMinorPKR: 24_240_000 },
    });
    expect(
      res.body.lineItems.map(
        (l: { quantity: number; unitAmountMinor: number; supplier: string }) => [
          l.quantity,
          l.unitAmountMinor,
          l.supplier,
        ],
      ),
    ).toEqual([
      [12, 5_000, 'Waqar-e-Madina Group (WMT)'],
      [8, 5_400, 'Waqar-e-Madina Group (WMT)'],
      [4, 55_000, 'Waqar-e-Madina Group (WMT)'],
    ]);
    expect(res.body.exclusions).toContain('Meals');

    const lead = await LeadModel.findById(leadId).lean();
    expect(lead?.status).toBe('quote_in_progress');
    const steps = await AuditEventModel.find({ action: 'lead.status', entityId: leadId })
      .sort({ at: 1 })
      .lean();
    expect(steps.map((s) => (s.after as { status: string }).status)).toEqual([
      'contacted',
      'quote_in_progress',
    ]);

    const again = await request(app)
      .post(`${ADMIN}/leads/${leadId}/quotes`)
      .set('Cookie', sales.header());
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'draft_exists',
      fields: { existingId: res.body.id },
    });
  });

  it('recalculates totals when a draft is saved, in SAR and PKR', async () => {
    const leadId = await leadByReference((await submit(inquiry())).body.reference);
    const draft = (
      await request(app).post(`${ADMIN}/leads/${leadId}/quotes`).set('Cookie', sales.header())
    ).body;
    const future = new Date(Date.now() + 5 * 24 * 3_600_000).toISOString().slice(0, 10);
    const res = await request(app)
      .put(`${ADMIN}/quotes/${draft.id}`)
      .set('Cookie', sales.header())
      .send({
        lineItems: [
          {
            description: 'Hotel Makkah',
            supplier: 'WMT',
            quantity: 12,
            unitAmountMinor: 5_000,
            currency: 'SAR',
          },
          {
            description: 'Flights ISB-JED return',
            supplier: 'PIA via agent',
            quantity: 4,
            unitAmountMinor: 18_000_000,
            currency: 'PKR',
          },
        ],
        exclusions: ['Meals'],
        terms: 'Our terms',
        expiresOn: future,
      });
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      totalMinorPKR: 4_500_000 + 72_000_000,
      totalMinorSAR: 60_000 + 960_000,
    });
    expect(res.body.expiresAt).toBe(new Date(`${future}T23:59:59.999+05:00`).toISOString());

    const past = await request(app)
      .put(`${ADMIN}/quotes/${draft.id}`)
      .set('Cookie', sales.header())
      .send({ lineItems: [], exclusions: [], terms: '', expiresOn: '2020-01-01' });
    expect(past.status).toBe(400);
    expect(past.body.error.fields.expiresOn).toBeDefined();
  });

  it('sends: link shown once, only its hash stored, emailed, lead -> quote_sent, no more edits', async () => {
    const { leadId, quoteId, token } = await sentQuote();
    expect(token).toHaveLength(43);

    const stored = await QuoteModel.findById(quoteId).lean();
    expect(stored?.status).toBe('sent');
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.publicTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await AuditEventModel.find().lean())).not.toContain(token);

    const mail = email.sent.find((m) => m.kind === 'quote.sent');
    expect(mail).toMatchObject({ to: 'aisha@example.com' });
    expect(mail?.text).toContain(`https://site.test/q/${token}`);
    expect((await LeadModel.findById(leadId).lean())?.status).toBe('quote_sent');

    const edit = await request(app)
      .put(`${ADMIN}/quotes/${quoteId}`)
      .set('Cookie', sales.header())
      .send({ lineItems: [], exclusions: [], terms: '', expiresOn: '2030-01-01' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('quote_not_draft');
  });

  it('the customer sees the sent quote, with no internal ids', async () => {
    const { reference, token } = await sentQuote();
    const res = await request(app).get(`${PUBLIC}/quotes/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      reference,
      version: 1,
      status: 'sent',
      travelerName: 'Aisha Khan',
      canAccept: true,
      hasNewerVersion: false,
      totals: { totalMinorSAR: 323_200, totalMinorPKR: 24_240_000 },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{24}/);
    expect(JSON.stringify(res.body)).not.toMatch(/0300|1234567|aisha@example/);
  });

  it('a new version replaces the old link, which leads to the new one; accepting follows it', async () => {
    const { leadId, quoteId, token: oldToken } = await sentQuote();
    const v2 = await request(app)
      .post(`${ADMIN}/quotes/${quoteId}/new-version`)
      .set('Cookie', sales.header());
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, status: 'draft', previousId: quoteId });

    // Until the new version is sent, the old link still works as before.
    expect((await request(app).get(`${PUBLIC}/quotes/${oldToken}`)).body.status).toBe('sent');

    const sent = await request(app)
      .post(`${ADMIN}/quotes/${v2.body.id}/send`)
      .set('Cookie', sales.header());
    const newToken = LINK.exec(sent.body.link)?.[1] as string;
    expect(newToken).not.toBe(oldToken);

    const old = await request(app).get(`${PUBLIC}/quotes/${oldToken}`);
    expect(old.body).toMatchObject({
      status: 'replaced',
      version: 1,
      hasNewerVersion: true,
      canAccept: false,
    });
    const followed = await request(app)
      .get(`${PUBLIC}/quotes/${oldToken}`)
      .query({ follow: 'latest' });
    expect(followed.body).toMatchObject({ status: 'sent', version: 2, viaOlderLink: true });

    const refused = await request(app).post(`${PUBLIC}/quotes/${oldToken}/accept`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('quote_replaced');

    const accepted = await request(app)
      .post(`${PUBLIC}/quotes/${oldToken}/accept`)
      .query({ follow: 'latest' });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', version: 2, canAccept: false });
    expect((await LeadModel.findById(leadId).lean())?.status).toBe('accepted');
    expect(email.sent.at(-1)).toMatchObject({
      kind: 'staff.quote_accepted',
      to: 'staff@agency.test',
    });

    // Accepting twice is harmless.
    expect((await request(app).post(`${PUBLIC}/quotes/${newToken}/accept`)).body.status).toBe(
      'accepted',
    );
    expect(await AuditEventModel.countDocuments({ action: 'quote.accept' })).toBe(1);
  });

  it('cannot send a new version after the customer accepted the previous one', async () => {
    const { quoteId, token } = await sentQuote();
    const v2 = await request(app)
      .post(`${ADMIN}/quotes/${quoteId}/new-version`)
      .set('Cookie', sales.header());
    await request(app).post(`${PUBLIC}/quotes/${token}/accept`);
    const send = await request(app)
      .post(`${ADMIN}/quotes/${v2.body.id}/send`)
      .set('Cookie', sales.header());
    expect(send.status).toBe(409);
    expect(send.body.error.code).toBe('previous_accepted');
  });

  describe('at the same moment (the stored status is re-checked when writing)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('an acceptance that lands just after the send check is not overwritten', async () => {
      const { quoteId, token } = await sentQuote();
      const v2 = await request(app)
        .post(`${ADMIN}/quotes/${quoteId}/new-version`)
        .set('Cookie', sales.header());
      // When the send loads the previous version, the customer accepts it right after.
      const findById = QuoteModel.findById.bind(QuoteModel);
      vi.spyOn(QuoteModel, 'findById').mockImplementation(((
        ...args: Parameters<typeof findById>
      ) => {
        const query = findById(...args);
        if (String(args[0]) !== quoteId) return query;
        return query.then(async (stale) => {
          await QuoteModel.collection.updateOne(
            { _id: stale?._id },
            { $set: { status: 'accepted', acceptedAt: new Date() } },
          );
          return stale; // the send still holds the old "sent" copy
        });
      }) as unknown as typeof QuoteModel.findById);

      email.sent.length = 0;
      const send = await request(app)
        .post(`${ADMIN}/quotes/${v2.body.id}/send`)
        .set('Cookie', sales.header());
      vi.restoreAllMocks();
      expect(send.status).toBe(409);
      expect(send.body.error.code).toBe('previous_accepted');
      expect((await QuoteModel.findById(quoteId).lean())?.status).toBe('accepted');
      expect((await QuoteModel.findById(v2.body.id).lean())?.status).toBe('draft');
      expect(email.sent.filter((m) => m.kind === 'quote.sent')).toEqual([]);
      const view = await request(app).get(`${PUBLIC}/quotes/${token}`);
      expect(view.body.status).toBe('accepted');
    });

    it('a quote replaced just after the accept check is not accepted', async () => {
      const { quoteId, leadId, token } = await sentQuote();
      // When the accept loads the quote by its link, staff replace it right after.
      const findOne = QuoteModel.findOne.bind(QuoteModel);
      vi.spyOn(QuoteModel, 'findOne').mockImplementation(((...args: Parameters<typeof findOne>) => {
        const query = findOne(...args);
        const filter = args[0] as Record<string, unknown> | undefined;
        if (!filter || !('publicTokenHash' in filter)) return query;
        return query.then(async (stale) => {
          await QuoteModel.collection.updateOne(
            { _id: stale?._id },
            { $set: { status: 'replaced' } },
          );
          return stale; // the accept still holds the old "sent" copy
        });
      }) as unknown as typeof QuoteModel.findOne);

      const accept = await request(app).post(`${PUBLIC}/quotes/${token}/accept`);
      vi.restoreAllMocks();
      expect(accept.status).toBe(409);
      expect(accept.body.error.code).toBe('quote_replaced');
      expect((await QuoteModel.findById(quoteId).lean())?.status).toBe('replaced');
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('quote_sent');
    });

    it('two accept clicks at once both get the accepted page', async () => {
      const { token } = await sentQuote();
      const [a, b] = await Promise.all([
        request(app).post(`${PUBLIC}/quotes/${token}/accept`),
        request(app).post(`${PUBLIC}/quotes/${token}/accept`),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.status, b.body.status]).toEqual(['accepted', 'accepted']);
    });

    it('a draft sent just after the save check is not changed by the save', async () => {
      const leadId = await leadByReference((await submit(inquiry())).body.reference);
      const draft = (
        await request(app).post(`${ADMIN}/leads/${leadId}/quotes`).set('Cookie', sales.header())
      ).body;
      const before = await QuoteModel.findById(draft.id).lean();
      // When the save loads the draft, another click sends it right after.
      const race = afterRead(
        QuoteModel,
        'findById',
        (args) => String(args[0]) === draft.id,
        async (stale) => {
          await QuoteModel.collection.updateOne(
            { _id: stale?._id as never },
            { $set: { status: 'sent', sentAt: new Date(), publicTokenHash: 'f'.repeat(64) } },
          );
        },
      );
      const res = await request(app)
        .put(`${ADMIN}/quotes/${draft.id}`)
        .set('Cookie', sales.header())
        .send({
          lineItems: [
            {
              description: 'Changed',
              supplier: 'X',
              quantity: 1,
              unitAmountMinor: 100,
              currency: 'SAR',
            },
          ],
          exclusions: [],
          terms: 'Changed terms',
          expiresOn: new Date(Date.now() + 5 * 24 * 3_600_000).toISOString().slice(0, 10),
        });
      vi.restoreAllMocks();
      expect(race.injected()).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('quote_not_draft');
      const stored = await QuoteModel.findById(draft.id).lean();
      expect(stored?.status).toBe('sent');
      expect(stored?.lineItems).toEqual(before?.lineItems);
      expect(stored?.totals).toEqual(before?.totals);
      expect(stored?.terms).toBe(before?.terms);
      expect(await AuditEventModel.countDocuments({ action: 'quote.update' })).toBe(0);
    });

    it('an acceptance stored after a view read the quote is never turned into "expired"', async () => {
      const { quoteId, token } = await sentQuote();
      // The deadline has just passed when a view loads the quote...
      await QuoteModel.updateOne(
        { _id: quoteId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      // ...and the customer's acceptance (made in time) is stored right after that load.
      const race = afterRead(
        QuoteModel,
        'findOne',
        (args) => Boolean(args[0]) && 'publicTokenHash' in (args[0] as object),
        async (stale) => {
          await QuoteModel.collection.updateOne(
            { _id: stale?._id as never },
            { $set: { status: 'accepted', acceptedAt: new Date(Date.now() - 2000) } },
          );
        },
      );
      const view = await request(app).get(`${PUBLIC}/quotes/${token}`);
      vi.restoreAllMocks();
      expect(race.injected()).toBe(true);
      expect(view.status).toBe(200);
      expect(view.body.status).toBe('accepted');
      expect((await QuoteModel.findById(quoteId).lean())?.status).toBe('accepted');
      expect(await AuditEventModel.countDocuments({ action: 'quote.expire' })).toBe(0);
    });

    it('a quote whose deadline passes during the acceptance is not accepted', async () => {
      const { quoteId, leadId, token } = await sentQuote();
      // The accept loads the quote just before its deadline; the deadline passes before the write.
      const race = afterRead(
        QuoteModel,
        'findOne',
        (args) => Boolean(args[0]) && 'publicTokenHash' in (args[0] as object),
        async (stale) => {
          await QuoteModel.collection.updateOne(
            { _id: stale?._id as never },
            { $set: { expiresAt: new Date(Date.now() - 1000) } },
          );
        },
      );
      email.sent.length = 0;
      const accept = await request(app).post(`${PUBLIC}/quotes/${token}/accept`);
      vi.restoreAllMocks();
      expect(race.injected()).toBe(true);
      expect(accept.status).toBe(409);
      expect(accept.body.error.code).toBe('quote_expired');
      const stored = await QuoteModel.findById(quoteId).lean();
      expect(stored?.status).toBe('expired');
      expect(stored?.acceptedAt).toBeNull();
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('quote_sent');
      expect(email.sent.filter((m) => m.kind === 'staff.quote_accepted')).toEqual([]);
      expect(await AuditEventModel.countDocuments({ action: 'quote.accept' })).toBe(0);
    });

    it('sending on a closed lead is refused with nothing written (no transaction, as on a single server)', async () => {
      const leadId = await leadByReference((await submit(inquiry())).body.reference);
      const draft = (
        await request(app).post(`${ADMIN}/leads/${leadId}/quotes`).set('Cookie', sales.header())
      ).body;
      const lost = await request(app)
        .patch(`${ADMIN}/leads/${leadId}`)
        .set('Cookie', sales.header())
        .send({ status: 'lost' });
      expect(lost.status).toBe(200);

      withoutTransactions();
      email.sent.length = 0;
      const send = await request(app)
        .post(`${ADMIN}/quotes/${draft.id}/send`)
        .set('Cookie', sales.header());
      vi.restoreAllMocks();
      expect(send.status).toBe(409);
      expect(send.body.error.code).toBe('lead_closed');
      const stored = await QuoteModel.findById(draft.id).lean();
      expect(stored).toMatchObject({ status: 'draft', sentAt: null });
      expect(stored?.publicTokenHash).toBeUndefined();
      expect(email.sent.filter((m) => m.kind === 'quote.sent')).toEqual([]);
      expect(await AuditEventModel.countDocuments({ action: 'quote.send' })).toBe(0);
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('lost');
    });

    it('a lead closed just after the send check leaves both versions untouched (no transaction)', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      const v2 = (
        await request(app)
          .post(`${ADMIN}/quotes/${quoteId}/new-version`)
          .set('Cookie', sales.header())
      ).body;
      withoutTransactions();
      // When the send loads the lead (still open), staff mark it lost right after.
      const race = afterRead(
        LeadModel,
        'findById',
        (args) => String(args[0]) === leadId,
        async (stale) => {
          await LeadModel.collection.updateOne(
            { _id: stale?._id as never },
            { $set: { status: 'lost' } },
          );
        },
      );
      email.sent.length = 0;
      const send = await request(app)
        .post(`${ADMIN}/quotes/${v2.id}/send`)
        .set('Cookie', sales.header());
      vi.restoreAllMocks();
      expect(race.injected()).toBe(true);
      expect(send.status).toBe(409);
      expect(send.body.error.code).toBe('lead_closed');
      const [v1Stored, v2Stored] = await Promise.all([
        QuoteModel.findById(quoteId).lean(),
        QuoteModel.findById(v2.id).lean(),
      ]);
      expect(v1Stored).toMatchObject({ status: 'sent', replacedById: null });
      expect(v2Stored).toMatchObject({ status: 'draft', sentAt: null });
      expect(v2Stored?.publicTokenHash).toBeUndefined();
      expect(email.sent.filter((m) => m.kind === 'quote.sent')).toEqual([]);
      expect(await AuditEventModel.countDocuments({ action: 'quote.replace' })).toBe(0);
      expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).body.status).toBe('sent');
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('lost');
    });
  });

  it('an expired quote says so and cannot be accepted', async () => {
    const { quoteId, token } = await sentQuote();
    await QuoteModel.updateOne(
      { _id: quoteId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const view = await request(app).get(`${PUBLIC}/quotes/${token}`);
    expect(view.body).toMatchObject({ status: 'expired', canAccept: false });
    const accept = await request(app).post(`${PUBLIC}/quotes/${token}/accept`);
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe('quote_expired');
    expect(
      await AuditEventModel.countDocuments({ action: 'quote.expire', actorRole: 'system' }),
    ).toBe(1);
  });

  it('"Ask a question" reaches staff on the lead', async () => {
    const { leadId, token } = await sentQuote();
    const res = await request(app)
      .post(`${PUBLIC}/quotes/${token}/message`)
      .send({ body: 'Can we have a higher floor?' });
    expect(res.status).toBe(201);
    const message = await MessageModel.findOne({ leadId }).lean();
    expect(message).toMatchObject({
      direction: 'inbound',
      channel: 'site',
      body: 'Can we have a higher floor?',
    });
    expect(email.sent.at(-1)?.kind).toBe('staff.question');
    expect(
      (await request(app).post(`${PUBLIC}/quotes/${token}/message`).send({ body: ' ' })).status,
    ).toBe(400);
  });

  it('declining the lead declines the quote the customer has', async () => {
    const { leadId, quoteId, token } = await sentQuote();
    const res = await request(app)
      .patch(`${ADMIN}/leads/${leadId}`)
      .set('Cookie', sales.header())
      .send({ status: 'declined' });
    expect(res.status).toBe(200);
    expect((await QuoteModel.findById(quoteId).lean())?.status).toBe('declined');
    expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).body.status).toBe('declined');
  });

  // Lead-status races (M1, L1). Run without transactions, as on a single-server
  // MongoDB, so only the conditional writes can keep the statuses right.
  describe('lead status at the same moment (no transaction, as on a single server)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a customer acceptance that wins against a staff decline keeps quote and lead accepted', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      withoutTransactions();
      // Right after the decline has read the lead (still "quote sent"), the customer accepts.
      let accepted: { status: number; body: { status?: string } } | undefined;
      const race = afterRead(
        LeadModel,
        'findById',
        (args) => String(args[0]) === leadId,
        async () => {
          accepted = await request(app).post(`${PUBLIC}/quotes/${token}/accept`);
        },
      );
      const decline = await request(app)
        .patch(`${ADMIN}/leads/${leadId}`)
        .set('Cookie', sales.header())
        .send({ status: 'declined' });
      vi.restoreAllMocks();

      expect(race.injected()).toBe(true);
      expect(accepted?.status).toBe(200);
      expect(accepted?.body.status).toBe('accepted');
      // The decline was decided from an old status: refused, nothing changed.
      expect(decline.status).toBe(409);
      expect(decline.body.error).toMatchObject({
        code: 'lead_changed',
        fields: { status: 'accepted' },
      });
      expect((await QuoteModel.findById(quoteId).lean())?.status).toBe('accepted');
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('accepted');
      expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).body.status).toBe('accepted');
      expect(await AuditEventModel.countDocuments({ action: 'quote.decline' })).toBe(0);
      expect(await AuditEventModel.countDocuments({ action: 'lead.update' })).toBe(0);
    });

    it('a staff decline that wins against a customer acceptance keeps quote and lead declined', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      withoutTransactions();
      // The lead is already declined; the customer accepts before the quote is declined.
      let accepted: { status: number; body: { error?: { code?: string } } } | undefined;
      const race = afterRead(
        QuoteModel,
        'find',
        (args) => {
          const filter = args[0] as Record<string, unknown> | undefined;
          return filter?.status === 'sent' && Boolean(filter.leadId);
        },
        async () => {
          accepted = await request(app).post(`${PUBLIC}/quotes/${token}/accept`);
        },
      );
      email.sent.length = 0;
      const decline = await request(app)
        .patch(`${ADMIN}/leads/${leadId}`)
        .set('Cookie', sales.header())
        .send({ status: 'declined' });
      vi.restoreAllMocks();

      expect(race.injected()).toBe(true);
      expect(decline.status).toBe(200);
      expect(accepted?.status).toBe(409);
      expect(accepted?.body.error?.code).toBe('quote_declined');
      expect((await QuoteModel.findById(quoteId).lean())?.status).toBe('declined');
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('declined');
      expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).body.status).toBe('declined');
      expect(await AuditEventModel.countDocuments({ action: 'quote.accept' })).toBe(0);
      expect(email.sent.filter((m) => m.kind === 'staff.quote_accepted')).toEqual([]);
    });

    it('two staff status changes at the same moment: the second is refused, not written over the first', async () => {
      const leadId = await leadByReference((await submit(inquiry())).body.reference);
      withoutTransactions();
      // Staff A asks for "contacted"; right after A's request read the lead, staff B marks it lost.
      let second: { status: number } | undefined;
      const race = afterRead(
        LeadModel,
        'findById',
        (args) => String(args[0]) === leadId,
        async () => {
          second = await request(app)
            .patch(`${ADMIN}/leads/${leadId}`)
            .set('Cookie', admin.header())
            .send({ status: 'lost' });
        },
      );
      const first = await request(app)
        .patch(`${ADMIN}/leads/${leadId}`)
        .set('Cookie', sales.header())
        .send({ status: 'contacted' });
      vi.restoreAllMocks();

      expect(race.injected()).toBe(true);
      expect(second?.status).toBe(200);
      expect(first.status).toBe(409);
      expect(first.body.error).toMatchObject({ code: 'lead_changed', fields: { status: 'lost' } });
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('lost');
      const updates = await AuditEventModel.find({ action: 'lead.update' }).lean();
      expect(updates.map((a) => (a.after as { status: string }).status)).toEqual(['lost']);

      // Normal changes still work, and an invalid one is still refused as before.
      const fresh = await leadByReference(
        (
          await submit(
            inquiry({ traveler: { name: 'Omar', phone: '0321 7654321', language: 'en' } }),
          )
        ).body.reference,
      );
      const ok = await request(app)
        .patch(`${ADMIN}/leads/${fresh}`)
        .set('Cookie', sales.header())
        .send({ status: 'contacted' });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('contacted');
      const invalid = await request(app)
        .patch(`${ADMIN}/leads/${fresh}`)
        .set('Cookie', sales.header())
        .send({ status: 'accepted' });
      expect(invalid.status).toBe(409);
      expect(invalid.body.error.code).toBe('invalid_transition');
    });

    it('building a quote never moves a lead that staff closed at the same moment', async () => {
      const leadId = await leadByReference((await submit(inquiry())).body.reference);
      withoutTransactions();
      // Right after "Create quote" read the lead (still "new"), staff mark it lost.
      const race = afterRead(
        LeadModel,
        'findById',
        (args) => String(args[0]) === leadId,
        async () => {
          const lost = await request(app)
            .patch(`${ADMIN}/leads/${leadId}`)
            .set('Cookie', admin.header())
            .send({ status: 'lost' });
          expect(lost.status).toBe(200);
        },
      );
      const create = await request(app)
        .post(`${ADMIN}/leads/${leadId}/quotes`)
        .set('Cookie', sales.header());
      vi.restoreAllMocks();

      expect(race.injected()).toBe(true);
      expect(create.status).toBe(409);
      expect(create.body.error.code).toBe('lead_closed');
      expect((await LeadModel.findById(leadId).lean())?.status).toBe('lost');
      expect(await QuoteModel.countDocuments({ leadId })).toBe(0);
      expect(await AuditEventModel.countDocuments({ action: 'lead.status' })).toBe(0);
    });
  });
});

describe('contact details belong to each inquiry', () => {
  /** A second trip from the same phone (a different arrival day, so not a duplicate). */
  const laterTrip = () => ({ ...tripInputs, arrivalDate: '2027-02-09' });

  async function sendQuoteFor(leadId: string) {
    const draft = await request(app)
      .post(`${ADMIN}/leads/${leadId}/quotes`)
      .set('Cookie', sales.header());
    expect(draft.status).toBe(201);
    const sent = await request(app)
      .post(`${ADMIN}/quotes/${draft.body.id}/send`)
      .set('Cookie', sales.header());
    expect(sent.status).toBe(200);
    return sent.body as { link: string; emailed: boolean };
  }

  it('a later inquiry without an email never sends its quote to the earlier address', async () => {
    const first = await submit(inquiry());
    const second = await submit(
      inquiry({
        inputs: laterTrip(),
        traveler: { name: 'Aisha Khan', phone: '0300 1234567', language: 'ur' },
      }),
    );
    expect(second.body.duplicate).toBe(false);
    const secondLead = await leadByReference(second.body.reference);

    email.sent.length = 0;
    const sent = await sendQuoteFor(secondLead);
    expect(sent.emailed).toBe(false);
    expect(email.sent.filter((m) => m.kind === 'quote.sent')).toEqual([]);
    const detail = await request(app)
      .get(`${ADMIN}/leads/${secondLead}`)
      .set('Cookie', sales.header());
    expect(detail.body.traveler.email).toBeNull();

    // The first lead still goes to the address given with it.
    await sendQuoteFor(await leadByReference(first.body.reference));
    expect(email.sent.filter((m) => m.kind === 'quote.sent').map((m) => m.to)).toEqual([
      'aisha@example.com',
    ]);
  });

  it("a later inquiry from the same phone does not redirect an earlier lead's quote", async () => {
    const first = await submit(inquiry());
    const second = await submit(
      inquiry({
        inputs: laterTrip(),
        traveler: {
          name: 'Bilal Khan',
          phone: '0300 1234567',
          email: 'bilal@example.com',
          language: 'en',
        },
      }),
    );
    const firstLead = await leadByReference(first.body.reference);
    const secondLead = await leadByReference(second.body.reference);

    email.sent.length = 0;
    const { link } = await sendQuoteFor(firstLead);
    const mail = email.sent.find((m) => m.kind === 'quote.sent');
    expect(mail?.to).toBe('aisha@example.com');
    expect(mail?.text).toContain('السلام علیکم'); // Urdu, as asked with the first inquiry

    const token = LINK.exec(link)?.[1] as string;
    const view = await request(app).get(`${PUBLIC}/quotes/${token}`);
    expect(view.body.travelerName).toBe('Aisha Khan');

    const firstDetail = await request(app)
      .get(`${ADMIN}/leads/${firstLead}`)
      .set('Cookie', sales.header());
    expect(firstDetail.body.traveler).toMatchObject({
      name: 'Aisha Khan',
      email: 'aisha@example.com',
      language: 'ur',
    });
    const secondDetail = await request(app)
      .get(`${ADMIN}/leads/${secondLead}`)
      .set('Cookie', sales.header());
    expect(secondDetail.body.traveler).toMatchObject({
      name: 'Bilal Khan',
      email: 'bilal@example.com',
      language: 'en',
    });

    // Staff can still find the first lead by the name given with it.
    const search = await request(app).get(`${ADMIN}/leads?q=Aisha`).set('Cookie', sales.header());
    expect(search.body.items.map((l: { reference: string }) => l.reference)).toContain(
      first.body.reference,
    );
  });
});

describe('quote link security', () => {
  it('unknown and malformed tokens get the same 404', async () => {
    await sentQuote();
    const random = Buffer.from(
      Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)),
    ).toString('base64url');
    const answers = await Promise.all(
      [random, 'abc', `${random}x`, '../../admin', 'a'.repeat(43)].map((t) =>
        request(app).get(`${PUBLIC}/quotes/${encodeURIComponent(t)}`),
      ),
    );
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: {
          code: 'quote_not_found',
          message: 'This link is not valid. Please check it or contact us.',
        },
      });
    }
    expect((await request(app).post(`${PUBLIC}/quotes/${random}/accept`)).status).toBe(404);
    expect(
      (await request(app).post(`${PUBLIC}/quotes/${random}/message`).send({ body: 'hi' })).status,
    ).toBe(404);
  });

  it("one customer's link never opens another quote", async () => {
    const a = await sentQuote();
    const b = await (async () => {
      const ref = (
        await submit(inquiry({ traveler: { name: 'Omar', phone: '0321 7654321', language: 'en' } }))
      ).body.reference;
      const leadId = await leadByReference(ref);
      const draft = await request(app)
        .post(`${ADMIN}/leads/${leadId}/quotes`)
        .set('Cookie', sales.header());
      const sent = await request(app)
        .post(`${ADMIN}/quotes/${draft.body.id}/send`)
        .set('Cookie', sales.header());
      return { reference: ref, token: LINK.exec(sent.body.link)?.[1] as string };
    })();
    expect((await request(app).get(`${PUBLIC}/quotes/${a.token}`)).body.reference).toBe(
      a.reference,
    );
    expect((await request(app).get(`${PUBLIC}/quotes/${b.token}`)).body.reference).toBe(
      b.reference,
    );
    // References are sequential, but they open nothing on their own.
    expect((await request(app).get(`${PUBLIC}/quotes/${a.reference}`)).status).toBe(404);
  });

  it('renewing a link turns the old one off', async () => {
    const { quoteId, token } = await sentQuote();
    const res = await request(app)
      .post(`${ADMIN}/quotes/${quoteId}/link`)
      .set('Cookie', sales.header());
    const fresh = LINK.exec(res.body.link)?.[1] as string;
    expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).status).toBe(404);
    expect((await request(app).get(`${PUBLIC}/quotes/${fresh}`)).status).toBe(200);
  });

  it('customer statuses all have wording; a draft never reaches a customer', async () => {
    const { reference } = (await submit(inquiry())).body;
    const leadId = await leadByReference(reference);
    await request(app).post(`${ADMIN}/leads/${leadId}/quotes`).set('Cookie', sales.header());
    // A draft has no token, so there is no link that could show it.
    expect(
      await QuoteModel.countDocuments({ status: 'draft', publicTokenHash: { $exists: true } }),
    ).toBe(0);
    expect(Object.keys(CUSTOMER_QUOTE_STATUS_WORDING.en).sort()).toEqual([
      'accepted',
      'declined',
      'expired',
      'replaced',
      'sent',
    ]);
  });
});

// Phase 6 review: a lead has at most one draft, one sent and one accepted quote,
// also when two requests arrive at the same moment. Each case runs inside real
// transactions (as on MongoDB Atlas) and as plain writes (a single server).
describe('one live quote per lead', () => {
  afterEach(() => vi.restoreAllMocks());

  const DAY = 24 * 3_600_000;

  /** The driver's own collection: writes here are never part of a request's transaction. */
  function raw(name: 'quotes' | 'leads') {
    const db = mongoose.connection.db;
    if (!db) throw new Error('not connected');
    return db.collection(name);
  }
  const oid = (value: string) => new mongoose.Types.ObjectId(value);

  /** Store a quote directly, as another request (or older data) would have left it. */
  async function rawQuote(leadId: string, fields: Record<string, unknown>): Promise<string> {
    const _id = new mongoose.Types.ObjectId();
    await raw('quotes').insertOne({
      _id,
      leadId: oid(leadId),
      version: 7,
      status: 'draft',
      lineItems: [
        {
          description: 'Hotel',
          supplier: 'WMT',
          quantity: 1,
          unitAmountMinor: 10_000,
          currency: 'SAR',
          notes: '',
        },
      ],
      exclusions: [],
      terms: '',
      fx: { rate: '75.00', effectiveAt: new Date() },
      totals: { totalMinorPKR: 750_000, totalMinorSAR: 10_000 },
      expiresAt: new Date(Date.now() + 3 * DAY),
      sentAt: null,
      acceptedAt: null,
      previousId: null,
      replacedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...fields,
    });
    return String(_id);
  }

  /**
   * Run `before` just before, or `after` just after, the first matching call of
   * `model.method`: the moment between a request's check and its write.
   */
  function around(
    model: object,
    method: 'create' | 'updateOne',
    hooks: {
      matches?: (args: unknown[]) => boolean;
      before?: () => Promise<void>;
      after?: () => Promise<void>;
    },
  ): { ran: () => boolean } {
    const target = model as Record<string, (...args: unknown[]) => unknown>;
    const original = (target[method] as (...args: unknown[]) => unknown).bind(model);
    let ran = false;
    vi.spyOn(target, method).mockImplementation(((...args: unknown[]) => {
      if (ran || (hooks.matches && !hooks.matches(args))) return original(...args);
      ran = true;
      return (async () => {
        await hooks.before?.();
        const result = await (original(...args) as PromiseLike<unknown>);
        await hooks.after?.();
        return result;
      })();
    }) as never);
    return { ran: () => ran };
  }

  /**
   * Make MongoDB run the next transaction twice, as it does after a write
   * conflict: the first attempt is rolled back, then `between` runs, then the
   * work runs again.
   */
  function retryFirstAttempt(between: () => Promise<void> = async () => undefined) {
    const real = mongoose.connection.transaction.bind(mongoose.connection) as unknown as (
      work: (...args: unknown[]) => Promise<void>,
    ) => Promise<void>;
    let attempts = 0;
    vi.spyOn(mongoose.connection, 'transaction').mockImplementation(((
      work: (...args: unknown[]) => Promise<unknown>,
    ) =>
      real(async (...args: unknown[]): Promise<void> => {
        attempts += 1;
        // The first attempt is gone by now, and this one has not read anything yet.
        if (attempts === 2) await between();
        await work(...args);
        if (attempts > 1) return;
        const conflict = new mongoose.mongo.MongoServerError({ message: 'simulated conflict' });
        conflict.addErrorLabel('TransientTransactionError');
        throw conflict;
      })) as never);
    return { attempts: () => attempts };
  }

  const newLead = async () => leadByReference((await submit(inquiry())).body.reference);
  const createDraft = (leadId: string, jar: CookieJar = sales) =>
    request(app).post(`${ADMIN}/leads/${leadId}/quotes`).set('Cookie', jar.header());
  const newVersion = (quoteId: string, jar: CookieJar = sales) =>
    request(app).post(`${ADMIN}/quotes/${quoteId}/new-version`).set('Cookie', jar.header());
  const send = (quoteId: string, jar: CookieJar = sales) =>
    request(app).post(`${ADMIN}/quotes/${quoteId}/send`).set('Cookie', jar.header());
  const renewLink = (quoteId: string) =>
    request(app).post(`${ADMIN}/quotes/${quoteId}/link`).set('Cookie', sales.header());
  const accept = (token: string) => request(app).post(`${PUBLIC}/quotes/${token}/accept`);
  const statusOf = async (quoteId: string) => (await QuoteModel.findById(quoteId).lean())?.status;
  const leadStatus = async (leadId: string) => (await LeadModel.findById(leadId).lean())?.status;
  const audits = (action: string) => AuditEventModel.countDocuments({ action });
  const liveCounts = async (leadId: string) => ({
    draft: await QuoteModel.countDocuments({ leadId, status: 'draft' }),
    sent: await QuoteModel.countDocuments({ leadId, status: 'sent' }),
    accepted: await QuoteModel.countDocuments({ leadId, status: 'accepted' }),
  });

  /** The winner (2xx) and the loser of two requests made at the same moment. */
  function winnerAndLoser<T extends { status: number }>(a: T, b: T): { winner: T; loser: T } {
    expect([a.status, b.status].filter((status) => status < 300)).toHaveLength(1);
    return a.status < 300 ? { winner: a, loser: b } : { winner: b, loser: a };
  }

  const MODES: [name: string, useMode: () => void][] = [
    ['inside transactions', () => undefined],
    ['without transactions (a single server)', withoutTransactions],
  ];
  describe.each(MODES)('%s', (_name, useMode) => {
    it('two staff creating a quote at the same moment: one draft, the other is pointed to it', async () => {
      const leadId = await newLead();
      useMode();
      const [a, b] = await Promise.all([createDraft(leadId, sales), createDraft(leadId, admin)]);
      vi.restoreAllMocks();
      const { winner, loser } = winnerAndLoser(a, b);
      expect(winner.status).toBe(201);
      expect(loser.status).toBe(409);
      expect(loser.body.error).toMatchObject({
        code: 'draft_exists',
        fields: { existingId: winner.body.id },
      });
      expect(await QuoteModel.countDocuments({ leadId })).toBe(1);
      expect(await audits('quote.create')).toBe(1);
      // The lead moved forward once: new -> contacted -> quote_in_progress.
      expect(await leadStatus(leadId)).toBe('quote_in_progress');
      expect(await audits('lead.status')).toBe(2);
    });

    it('two staff making a new version at the same moment: one new draft', async () => {
      const { leadId, quoteId } = await sentQuote();
      useMode();
      const [a, b] = await Promise.all([newVersion(quoteId, sales), newVersion(quoteId, admin)]);
      vi.restoreAllMocks();
      const { winner, loser } = winnerAndLoser(a, b);
      expect(winner.body).toMatchObject({ version: 2, status: 'draft', previousId: quoteId });
      expect(loser.status).toBe(409);
      expect(loser.body.error).toMatchObject({
        code: 'draft_exists',
        fields: { existingId: winner.body.id },
      });
      expect(await liveCounts(leadId)).toEqual({ draft: 1, sent: 1, accepted: 0 });
      const versions = await QuoteModel.find({ leadId }).sort({ version: 1 }).lean();
      expect(versions.map((q) => q.version)).toEqual([1, 2]);
      expect(await audits('quote.new_version')).toBe(1);
    });

    it('"Create quote" and "New version" at the same moment never leave two drafts', async () => {
      const { leadId, quoteId } = await sentQuote();
      // The sent quote lapses, so "Create quote" is allowed again; "New version" of it is not.
      await QuoteModel.updateOne(
        { _id: quoteId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      useMode();
      const [created, versioned] = await Promise.all([createDraft(leadId), newVersion(quoteId)]);
      vi.restoreAllMocks();
      expect(versioned.status).toBe(409);
      expect(created.status).toBe(201);
      expect(await liveCounts(leadId)).toEqual({ draft: 1, sent: 0, accepted: 0 });
    });

    it('the same draft sent twice at the same moment is sent once, with one link', async () => {
      const leadId = await newLead();
      const draft = (await createDraft(leadId)).body;
      email.sent.length = 0;
      useMode();
      const [a, b] = await Promise.all([send(draft.id, sales), send(draft.id, admin)]);
      vi.restoreAllMocks();
      const { winner, loser } = winnerAndLoser(a, b);
      expect(winner.body.link).toMatch(LINK);
      expect(loser.status).toBe(409);
      expect(loser.body.error.code).toBe('quote_not_draft');
      expect(await liveCounts(leadId)).toEqual({ draft: 0, sent: 1, accepted: 0 });
      expect(await audits('quote.send')).toBe(1);
      expect(email.sent.filter((m) => m.kind === 'quote.sent')).toHaveLength(1);
      // The link that was shown is the one that works.
      const token = LINK.exec(winner.body.link)?.[1] as string;
      expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).status).toBe(200);
      expect(await leadStatus(leadId)).toBe('quote_sent');
    });

    it('a new version sent twice at the same moment replaces the old one once', async () => {
      const { leadId, quoteId, token: oldToken } = await sentQuote();
      const v2 = (await newVersion(quoteId)).body;
      email.sent.length = 0;
      useMode();
      const [a, b] = await Promise.all([send(v2.id, sales), send(v2.id, admin)]);
      vi.restoreAllMocks();
      const { winner, loser } = winnerAndLoser(a, b);
      expect(loser.body.error.code).toBe('quote_not_draft');
      expect(await statusOf(quoteId)).toBe('replaced');
      expect(await liveCounts(leadId)).toEqual({ draft: 0, sent: 1, accepted: 0 });
      expect(await audits('quote.replace')).toBe(1);
      expect(email.sent.filter((m) => m.kind === 'quote.sent')).toHaveLength(1);
      // Versioning and links as before: the old link leads to the new version.
      const followed = await request(app)
        .get(`${PUBLIC}/quotes/${oldToken}`)
        .query({ follow: 'latest' });
      expect(followed.body).toMatchObject({ status: 'sent', version: 2, viaOlderLink: true });
      expect(LINK.exec(winner.body.link)?.[1]).not.toBe(oldToken);
    });

    it('a second draft stored just before the insert is refused by the index, as a 409', async () => {
      const leadId = await newLead();
      useMode();
      let other = '';
      // Both requests passed every check; the other one's draft lands first.
      const race = around(QuoteModel, 'create', {
        before: async () => {
          other = await rawQuote(leadId, { status: 'draft', version: 7 });
        },
      });
      const res = await createDraft(leadId);
      vi.restoreAllMocks();
      expect(race.ran()).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'draft_exists', fields: { existingId: other } });
      expect(JSON.stringify(res.body)).not.toMatch(/E11000|dup key|index/i);
      expect(await liveCounts(leadId)).toEqual({ draft: 1, sent: 0, accepted: 0 });
      expect(await audits('quote.create')).toBe(0);
    });

    it('a draft cannot be sent while the customer has another quote for the lead', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      // Older data: a second draft that is not a new version of the sent quote.
      const stray = await rawQuote(leadId, { status: 'draft', version: 2 });
      email.sent.length = 0;
      useMode();
      const res = await send(stray);
      vi.restoreAllMocks();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'other_quote_sent',
        fields: { existingId: quoteId },
      });
      const stored = await QuoteModel.findById(stray).lean();
      expect(stored).toMatchObject({ status: 'draft', sentAt: null });
      expect(stored?.publicTokenHash).toBeUndefined();
      expect(await statusOf(quoteId)).toBe('sent');
      expect(await audits('quote.send')).toBe(1);
      expect(email.sent.filter((m) => m.kind === 'quote.sent')).toEqual([]);
      expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).body.status).toBe('sent');
    });

    it('a lead accepted through one quote cannot be accepted through another', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      // Older data: the lead was already accepted through another quote.
      await rawQuote(leadId, { status: 'accepted', version: 2, acceptedAt: new Date() });
      await raw('leads').updateOne({ _id: oid(leadId) }, { $set: { status: 'accepted' } });
      email.sent.length = 0;
      useMode();
      const res = await accept(token);
      vi.restoreAllMocks();
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('quote_other_accepted');
      expect(await statusOf(quoteId)).toBe('sent');
      expect(await liveCounts(leadId)).toEqual({ draft: 0, sent: 1, accepted: 1 });
      expect(await audits('quote.accept')).toBe(0);
      expect(email.sent.filter((m) => m.kind === 'staff.quote_accepted')).toEqual([]);
    });

    it('another quote accepted at the same moment: the index refuses the second, as a 409', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      // The other acceptance has stored its quote but not yet moved the lead.
      await rawQuote(leadId, { status: 'accepted', version: 2, acceptedAt: new Date() });
      email.sent.length = 0;
      useMode();
      const res = await accept(token);
      vi.restoreAllMocks();
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('quote_other_accepted');
      expect(JSON.stringify(res.body)).not.toMatch(/E11000|dup key|index/i);
      const stored = await QuoteModel.findById(quoteId).lean();
      expect(stored).toMatchObject({ status: 'sent', acceptedAt: null });
      expect(await liveCounts(leadId)).toEqual({ draft: 0, sent: 1, accepted: 1 });
      expect(await audits('quote.accept')).toBe(0);
      expect(email.sent.filter((m) => m.kind === 'staff.quote_accepted')).toEqual([]);
      // Every stored lead status has its audit event (rule 2).
      const lead = await leadStatus(leadId);
      expect(await AuditEventModel.countDocuments({ 'after.status': 'accepted' })).toBe(
        lead === 'accepted' ? 1 : 0,
      );
    });

    it('an acceptance that lands while the link is being renewed keeps the accepted link', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      const before = await QuoteModel.findById(quoteId).lean();
      useMode();
      // Right after the renewal read the quote (still "sent"), the customer accepts.
      let accepted: { status: number } | undefined;
      const race = afterRead(
        QuoteModel,
        'findById',
        (args) => String(args[0]) === quoteId,
        async () => {
          accepted = await accept(token);
        },
      );
      const renewed = await renewLink(quoteId);
      vi.restoreAllMocks();
      expect(race.injected()).toBe(true);
      expect(accepted?.status).toBe(200);
      expect(renewed.status).toBe(409);
      expect(renewed.body.error.code).toBe('quote_not_sent');
      expect(renewed.body.link).toBeUndefined();
      const stored = await QuoteModel.findById(quoteId).lean();
      expect(stored?.status).toBe('accepted');
      expect(stored?.acceptedAt).toEqual(expect.any(Date));
      expect(stored?.publicTokenHash).toBe(before?.publicTokenHash);
      expect(await audits('quote.link_renewed')).toBe(0);
      // The customer's link still opens their accepted quote.
      expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).body.status).toBe('accepted');
      expect(await leadStatus(leadId)).toBe('accepted');
    });

    it('a link renewed while its old link is being accepted: the old link accepts nothing', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      useMode();
      // Right after the accept found the quote by the old link, staff renew the link.
      let fresh = '';
      const race = afterRead(
        QuoteModel,
        'findOne',
        (args) => Boolean(args[0]) && 'publicTokenHash' in (args[0] as object),
        async () => {
          const renewed = await renewLink(quoteId);
          expect(renewed.status).toBe(200);
          fresh = LINK.exec(renewed.body.link)?.[1] as string;
        },
      );
      email.sent.length = 0;
      const res = await accept(token);
      vi.restoreAllMocks();
      expect(race.injected()).toBe(true);
      // The same answer as any link that is not valid.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('quote_not_found');
      const stored = await QuoteModel.findById(quoteId).lean();
      expect(stored).toMatchObject({ status: 'sent', acceptedAt: null });
      expect(await leadStatus(leadId)).toBe('quote_sent');
      expect(await audits('quote.accept')).toBe(0);
      expect(email.sent.filter((m) => m.kind === 'staff.quote_accepted')).toEqual([]);
      // The new link is the quote's link, and it can still be accepted.
      expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).status).toBe(404);
      const viaFresh = await accept(fresh);
      expect(viaFresh.status).toBe(200);
      expect(viaFresh.body.status).toBe('accepted');
      expect(await leadStatus(leadId)).toBe('accepted');
    });

    it('a quote replaced or declined while its link is being renewed gets no new link', async () => {
      for (const status of ['replaced', 'declined'] as const) {
        const { quoteId, token } = await sentQuote();
        const before = await QuoteModel.findById(quoteId).lean();
        useMode();
        const race = afterRead(
          QuoteModel,
          'findById',
          (args) => String(args[0]) === quoteId,
          async (stale) => {
            await raw('quotes').updateOne({ _id: stale?._id as never }, { $set: { status } });
          },
        );
        const renewed = await renewLink(quoteId);
        vi.restoreAllMocks();
        expect(race.injected()).toBe(true);
        expect(renewed.status).toBe(409);
        expect(renewed.body.error.code).toBe('quote_not_sent');
        const stored = await QuoteModel.findById(quoteId).lean();
        expect(stored?.status).toBe(status);
        expect(stored?.publicTokenHash).toBe(before?.publicTokenHash);
        expect((await request(app).get(`${PUBLIC}/quotes/${token}`)).body.status).toBe(status);
        expect(await audits('quote.link_renewed')).toBe(0);
        // A different traveler for the second round.
        await raw('leads').updateMany({}, { $set: { dedupeKey: `done-${status}` } });
      }
    });
  });

  describe('a transaction that MongoDB runs twice', () => {
    /** A single server (MONGODB_TEST_STANDALONE=1) has no transactions to retry. */
    async function hasTransactions(): Promise<boolean> {
      const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
      return Boolean(hello?.setName) || hello?.msg === 'isdbgrid';
    }

    it('an acceptance is decided by its last attempt, not by an abandoned one', async (ctx) => {
      if (!(await hasTransactions())) return ctx.skip();
      const { leadId, quoteId, token } = await sentQuote();
      // First attempt: the lead is declined, so the acceptance is refused...
      await raw('leads').updateOne({ _id: oid(leadId) }, { $set: { status: 'declined' } });
      // ...but that attempt is rolled back, and by the second the lead is open again.
      const retry = retryFirstAttempt(async () => {
        await raw('leads').updateOne({ _id: oid(leadId) }, { $set: { status: 'quote_sent' } });
      });
      const res = await accept(token);
      vi.restoreAllMocks();
      expect(retry.attempts()).toBe(2);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'accepted', canAccept: false });
      expect(await statusOf(quoteId)).toBe('accepted');
      expect(await leadStatus(leadId)).toBe('accepted');
      expect(await audits('quote.accept')).toBe(1);
      expect(email.sent.at(-1)).toMatchObject({ kind: 'staff.quote_accepted' });
    });

    it('a refusal on the second attempt is not answered as the success of the first', async (ctx) => {
      if (!(await hasTransactions())) return ctx.skip();
      const { leadId, quoteId, token } = await sentQuote();
      // First attempt accepts; it is rolled back, and staff decline before the second.
      const retry = retryFirstAttempt(async () => {
        await raw('leads').updateOne({ _id: oid(leadId) }, { $set: { status: 'declined' } });
      });
      email.sent.length = 0;
      const res = await accept(token);
      vi.restoreAllMocks();
      expect(retry.attempts()).toBe(2);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('quote_declined');
      expect(await statusOf(quoteId)).toBe('sent');
      expect(await leadStatus(leadId)).toBe('declined');
      expect(await audits('quote.accept')).toBe(0);
      expect(email.sent.filter((m) => m.kind === 'staff.quote_accepted')).toEqual([]);
    });

    it('creating a quote still moves the lead forward, once', async (ctx) => {
      if (!(await hasTransactions())) return ctx.skip();
      const leadId = await newLead();
      const retry = retryFirstAttempt();
      const res = await createDraft(leadId);
      vi.restoreAllMocks();
      expect(retry.attempts()).toBe(2);
      expect(res.status).toBe(201);
      expect(await QuoteModel.countDocuments({ leadId })).toBe(1);
      expect(await leadStatus(leadId)).toBe('quote_in_progress');
      expect(await audits('lead.status')).toBe(2);
      expect(await audits('quote.create')).toBe(1);
    });
  });

  describe('without transactions (a single server): what the index catches is cleaned up', () => {
    it('a draft created and sent by someone else between the check and the insert: ours is withdrawn', async () => {
      const leadId = await newLead();
      withoutTransactions();
      let other = '';
      const race = around(QuoteModel, 'create', {
        before: async () => {
          other = await rawQuote(leadId, { status: 'sent', version: 7, sentAt: new Date() });
        },
      });
      const res = await createDraft(leadId);
      vi.restoreAllMocks();
      expect(race.ran()).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'open_quote_exists',
        fields: { existingId: other },
      });
      // No draft is left behind that could never be sent.
      expect(await liveCounts(leadId)).toEqual({ draft: 0, sent: 1, accepted: 0 });
      expect(await audits('quote.create')).toBe(0);
    });

    it('a version number taken at the same moment is a 409 to retry, not a 500', async () => {
      const leadId = await newLead();
      withoutTransactions();
      const race = around(QuoteModel, 'create', {
        before: async () => {
          await rawQuote(leadId, { status: 'expired', version: 1 });
        },
      });
      const res = await createDraft(leadId);
      vi.restoreAllMocks();
      expect(race.ran()).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
      expect(JSON.stringify(res.body)).not.toMatch(/E11000|dup key|index/i);
      expect(await QuoteModel.countDocuments({ leadId, status: 'draft' })).toBe(0);
      // Trying again works, with the next version number.
      const again = await createDraft(leadId);
      expect(again.status).toBe(201);
      expect(again.body.version).toBe(2);
    });

    it('a send the index refuses half-way leaves no old link pointing at a draft', async () => {
      const { leadId, quoteId, token } = await sentQuote();
      const v2 = (await newVersion(quoteId)).body;
      withoutTransactions();
      // Right after this send replaced version 1, another quote for the lead is sent.
      let other = '';
      const race = around(QuoteModel, 'updateOne', {
        matches: (args) =>
          (args[1] as { $set?: { status?: string } } | undefined)?.$set?.status === 'replaced',
        after: async () => {
          other = await rawQuote(leadId, { status: 'sent', version: 9, sentAt: new Date() });
        },
      });
      email.sent.length = 0;
      const res = await send(v2.id);
      vi.restoreAllMocks();
      expect(race.ran()).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'other_quote_sent',
        fields: { existingId: other },
      });
      const draft = await QuoteModel.findById(v2.id).lean();
      expect(draft).toMatchObject({ status: 'draft', sentAt: null });
      expect(draft?.publicTokenHash).toBeUndefined();
      expect(await liveCounts(leadId)).toEqual({ draft: 1, sent: 1, accepted: 0 });
      expect(email.sent.filter((m) => m.kind === 'quote.sent')).toEqual([]);
      // Version 1 leads to the quote the customer has, never to the unsent draft.
      const v1 = await QuoteModel.findById(quoteId).lean();
      expect(String(v1?.replacedById)).toBe(other);
      expect(await audits('quote.replace_undone')).toBe(1);
      const followed = await request(app)
        .get(`${PUBLIC}/quotes/${token}`)
        .query({ follow: 'latest' });
      expect(followed.body).toMatchObject({ status: 'sent', version: 9 });
    });
  });

  it('the database itself allows one draft, one sent and one accepted quote per lead', async () => {
    const leadId = await newLead();
    const index = (await QuoteModel.collection.indexes()).find(
      (i) => i.name === 'one_live_quote_per_status',
    );
    expect(index).toMatchObject({
      unique: true,
      key: { leadId: 1, status: 1 },
      partialFilterExpression: { status: { $in: ['draft', 'sent', 'accepted'] } },
    });
    let version = 1;
    for (const status of ['draft', 'sent', 'accepted']) {
      await rawQuote(leadId, { status, version: version++ });
      await expect(rawQuote(leadId, { status, version: version++ })).rejects.toMatchObject({
        code: 11000,
      });
    }
    // History is not limited.
    for (const status of ['replaced', 'expired', 'declined']) {
      await rawQuote(leadId, { status, version: version++ });
      await rawQuote(leadId, { status, version: version++ });
    }
    // Another lead is not affected.
    const otherLead = await leadByReference(
      (await submit(inquiry({ traveler: { name: 'Omar', phone: '0321 7654321', language: 'en' } })))
        .body.reference,
    );
    await rawQuote(otherLead, { status: 'draft', version: 1 });
  });

  it('a duplicate key no service expected is a 409 without database details', async () => {
    const { quoteId } = await sentQuote();
    vi.spyOn(QuoteModel, 'updateOne').mockRejectedValueOnce(
      Object.assign(
        new Error(
          'E11000 duplicate key error collection: msf.quotes index: publicTokenHash_1 dup key: { publicTokenHash: "abc" }',
        ),
        { code: 11000 },
      ),
    );
    const res = await renewLink(quoteId);
    vi.restoreAllMocks();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'conflict',
        message: 'This was changed by someone else at the same time. Reload and try again.',
      },
    });
  });
});
