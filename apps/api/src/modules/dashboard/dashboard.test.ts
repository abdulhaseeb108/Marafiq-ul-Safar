/**
 * Staff dashboard (docs/01 section 6.2): figures come from the database, the
 * windows are exact, sections follow the permission matrix (docs/02 section
 * 3), and no customer details leave the API.
 */
import type { DashboardSummary, LeadStatus, QuoteStatus, Role } from '@marafiq/shared';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, seedSupplier, signInWithRole, type CookieJar } from '../../test/helpers.js';
import { LeadModel, QuoteModel, TravelerModel } from '../leads/lead.models.js';
import { addDays } from '../pricing/engine.js';
import { todayInPakistan } from '../pricing/pricing.service.js';
import { RatePackageModel } from '../rate-sheets/rate-sheet.models.js';

const DASHBOARD = '/api/v1/admin/dashboard';
const HOUR = 3_600_000;
const TRAVELER_NAME = 'Fatima Dashboard-Private';
/** Phones are unique per traveler; every seeded one starts with this. */
const PHONE_PREFIX = '+9230077';

let leadCounter = 0;

async function seedLead(status: LeadStatus = 'new') {
  // Take the number before any await, so parallel calls never share one.
  leadCounter += 1;
  const n = leadCounter;
  const reference = `MSF-2026-${String(800_000 + n)}`;
  const traveler = await TravelerModel.create({
    name: TRAVELER_NAME,
    phone: `${PHONE_PREFIX}${String(n).padStart(5, '0')}`,
    language: 'en',
  });
  return LeadModel.create({
    reference,
    travelerId: traveler._id,
    source: 'umrah',
    status,
    consent: { textVersion: 'test', acceptedAt: new Date() },
    dedupeKey: `dash-${reference}`,
  });
}

/** One lead per quote: a lead may hold only one live quote of each status. */
async function seedQuote(status: QuoteStatus, expiresInHours: number) {
  const lead = await seedLead('quote_sent');
  const quote = await QuoteModel.create({
    leadId: lead._id,
    version: 1,
    status,
    lineItems: [
      {
        description: 'Hotel',
        supplier: 'WMT',
        quantity: 1,
        unitAmountMinor: 10_000,
        currency: 'SAR',
      },
    ],
    exclusions: [],
    terms: 'Terms',
    fx: { rate: '75.00', effectiveAt: new Date() },
    totals: { totalMinorPKR: 750_000, totalMinorSAR: 10_000 },
    expiresAt: new Date(Date.now() + expiresInHours * HOUR),
    ...(status === 'draft' ? {} : { sentAt: new Date(), publicTokenHash: `dash-${Math.random()}` }),
  });
  return { lead, quote };
}

async function seedPack(
  supplierId: string,
  overrides: {
    packName?: string;
    status?: 'draft' | 'needs_review' | 'published' | 'superseded' | 'rejected';
    nightTo?: string | null;
    version?: number;
    publishedAt?: Date | null;
  } = {},
) {
  const today = todayInPakistan();
  return RatePackageModel.create({
    supplierId,
    sourceDocumentId: new mongoose.Types.ObjectId(),
    packName: overrides.packName ?? 'Pack',
    nightFrom: addDays(today, -30),
    nightTo: overrides.nightTo === undefined ? addDays(today, 60) : overrides.nightTo,
    status: overrides.status ?? 'published',
    version: overrides.version ?? 1,
    publishedAt:
      overrides.publishedAt !== undefined
        ? overrides.publishedAt
        : (overrides.status ?? 'published') === 'published'
          ? new Date(Date.now() - 10 * 24 * HOUR)
          : null,
  });
}

describe('GET /admin/dashboard', () => {
  let app: Express;
  const jars = new Map<Role, CookieJar>();

  const get = async (role: Role) => {
    let jar = jars.get(role);
    if (!jar) {
      jar = (await signInWithRole(app, role)).jar;
      jars.set(role, jar);
    }
    return request(app).get(DASHBOARD).set('Cookie', jar.header());
  };

  beforeEach(() => {
    app = makeApp().app;
    jars.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('needs a signed-in staff member', async () => {
    const res = await request(app).get(DASHBOARD);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('shows zeros and nothing to list when the database is empty', async () => {
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as DashboardSummary;
    expect(body.leads).toEqual({ newCount: 0 });
    expect(body.quotes).toEqual({ windowHours: 48, expiringCount: 0, expiring: [] });
    expect(body.rates).toEqual({
      windowDays: 14,
      expiringCount: 0,
      expiring: [],
      lastPublished: null,
    });
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it('counts leads whose status is new, and no other status', async () => {
    await Promise.all([seedLead('new'), seedLead('new'), seedLead('new')]);
    await Promise.all([seedLead('contacted'), seedLead('quote_sent'), seedLead('lost')]);
    const body = (await get('sales')).body as DashboardSummary;
    expect(body.leads.newCount).toBe(3);
  });

  it('lists sent quotes expiring within 48 hours, soonest first', async () => {
    const soon = await seedQuote('sent', 1);
    const edge = await seedQuote('sent', 47.5);
    await seedQuote('sent', 49); // outside the window
    const res = await get('admin');
    const quotes = (res.body as DashboardSummary).quotes;
    expect(quotes?.expiringCount).toBe(2);
    expect(quotes?.expiring.map((q) => q.quoteId)).toEqual([soon.quote.id, edge.quote.id]);
    expect(quotes?.expiring[0]).toEqual({
      quoteId: soon.quote.id,
      leadId: soon.lead.id,
      leadReference: soon.lead.reference,
      version: 1,
      expiresAt: soon.quote.expiresAt.toISOString(),
    });
  });

  it('leaves out drafts, past-expiry, accepted, declined, expired and replaced quotes', async () => {
    const counted = await seedQuote('sent', 10);
    await seedQuote('sent', -1); // past expiry, not yet marked expired (lazy expiry)
    for (const status of ['draft', 'accepted', 'declined', 'expired', 'replaced'] as const) {
      await seedQuote(status, 10);
    }
    const quotes = ((await get('finance')).body as DashboardSummary).quotes;
    expect(quotes?.expiringCount).toBe(1);
    expect(quotes?.expiring.map((q) => q.quoteId)).toEqual([counted.quote.id]);
  });

  it('caps each list at 10 rows but always reports the full count', async () => {
    for (let i = 0; i < 12; i += 1) await seedQuote('sent', 1 + i);
    const quotes = ((await get('admin')).body as DashboardSummary).quotes;
    expect(quotes?.expiringCount).toBe(12);
    expect(quotes?.expiring).toHaveLength(10);
  });

  it('lists published packs whose last night is within 14 days, soonest first', async () => {
    const supplier = await seedSupplier({ name: 'Waqar-e-Madina' });
    const today = todayInPakistan();
    const endsToday = await seedPack(supplier.id, { packName: 'Ends today', nightTo: today });
    const endsDay14 = await seedPack(supplier.id, {
      packName: 'Ends day 14',
      nightTo: addDays(today, 14),
      version: 3,
    });
    await seedPack(supplier.id, { packName: 'Day 15', nightTo: addDays(today, 15) });
    await seedPack(supplier.id, { packName: 'Ended', nightTo: addDays(today, -1) });
    await seedPack(supplier.id, {
      packName: 'Old',
      status: 'superseded',
      nightTo: addDays(today, 3),
    });
    await seedPack(supplier.id, { packName: 'Draft', status: 'draft', nightTo: addDays(today, 3) });
    await seedPack(supplier.id, { packName: 'Rejected', status: 'rejected', nightTo: today });
    await seedPack(supplier.id, { packName: 'No dates', nightTo: null });

    const rates = ((await get('ops')).body as DashboardSummary).rates;
    expect(rates?.expiringCount).toBe(2);
    expect(rates?.expiring).toEqual([
      {
        packageId: endsToday.id,
        packName: 'Ends today',
        supplierName: 'Waqar-e-Madina',
        version: 1,
        nightTo: today,
      },
      {
        packageId: endsDay14.id,
        packName: 'Ends day 14',
        supplierName: 'Waqar-e-Madina',
        version: 3,
        nightTo: addDays(today, 14),
      },
    ]);
  });

  it('shows the most recently published rate version', async () => {
    const supplier = await seedSupplier({ name: 'WMT' });
    const now = Date.now();
    await seedPack(supplier.id, {
      packName: 'Shawal',
      version: 1,
      status: 'superseded',
      publishedAt: new Date(now - 5 * 24 * HOUR),
    });
    const latest = await seedPack(supplier.id, {
      packName: 'Shawal',
      version: 2,
      publishedAt: new Date(now - HOUR),
    });
    await seedPack(supplier.id, {
      packName: 'Ramadan',
      publishedAt: new Date(now - 3 * 24 * HOUR),
    });
    await seedPack(supplier.id, { packName: 'Unpublished draft', status: 'draft' });

    const rates = ((await get('admin')).body as DashboardSummary).rates;
    expect(rates?.lastPublished).toEqual({
      packageId: latest.id,
      packName: 'Shawal',
      supplierName: 'WMT',
      version: 2,
      status: 'published',
      publishedAt: latest.publishedAt?.toISOString(),
    });
  });

  it('gives each role only the sections it may see (docs/02 section 3)', async () => {
    const sections = async (role: Role) => {
      const body = (await get(role)).body as DashboardSummary;
      return {
        leads: body.leads !== null,
        quotes: body.quotes !== null,
        rates: body.rates !== null,
      };
    };
    expect(await sections('admin')).toEqual({ leads: true, quotes: true, rates: true });
    expect(await sections('sales')).toEqual({ leads: true, quotes: true, rates: false });
    expect(await sections('finance')).toEqual({ leads: true, quotes: true, rates: false });
    // Ops may not see quotes at all (decision 133).
    expect(await sections('ops')).toEqual({ leads: true, quotes: false, rates: true });
  });

  it('never sends customer names or phone numbers', async () => {
    await seedLead('new');
    await seedQuote('sent', 5);
    const res = await get('admin');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(TRAVELER_NAME);
    expect(text).not.toContain(PHONE_PREFIX);
    expect(text).not.toMatch(/"(name|phone|email|travelerId)"/);
  });

  it('answers a database failure with the standard 500, without its message', async () => {
    const jar = (await signInWithRole(app, 'admin')).jar;
    vi.spyOn(LeadModel, 'countDocuments').mockRejectedValueOnce(
      new Error('connection to mongodb://user:secret@db.internal lost'),
    );
    const res = await request(app).get(DASHBOARD).set('Cookie', jar.header());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
