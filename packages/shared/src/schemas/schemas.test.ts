import { describe, expect, it } from 'vitest';
import * as schemas from './index.js';

const id = '64b7f0c2a1b2c3d4e5f60718';
const id2 = '64b7f0c2a1b2c3d4e5f60719';
const now = '2026-11-11T08:00:00.000Z';
const base = { _id: id, createdAt: now, updatedAt: now };

const totals = { perPersonMinorPKR: 6_060_000, groupMinorPKR: 24_240_000, groupMinorSAR: 323_200 };
const fx = { rate: '75.00', effectiveAt: now };

/** One valid document per collection in docs/02 section 1. */
const valid = {
  UserSchema: {
    ...base,
    email: 'ops@example.com',
    name: 'Ops User',
    passwordHash: '$argon2id$placeholder',
    role: 'ops',
    active: true,
    lastLoginAt: null,
  },
  SupplierSchema: { ...base, name: 'Waqar-e-Madina Group', type: 'hotel_operator', active: true },
  HotelSchema: {
    ...base,
    city: 'makkah',
    canonicalName: 'Qila Ajiyad',
    aliases: [],
    distanceNote: 'Shahra Ajiad',
    transport: 'unknown',
    active: true,
  },
  SourceDocumentSchema: {
    ...base,
    supplierId: id,
    fileKey: 'rate-sheets/abc.pdf',
    fileName: 'pack01.pdf',
    mimeType: 'application/pdf',
    sha256: 'a'.repeat(64),
    receivedAt: now,
    uploadedBy: id2,
    extractionStatus: 'uploaded',
  },
  RatePackageSchema: {
    ...base,
    supplierId: id,
    sourceDocumentId: id2,
    packName: 'Ramadan Pack 01',
    seasonLabel: 'Ramadan',
    nightFrom: '2027-02-06',
    nightTo: '2027-02-26',
    effectiveFrom: '2026-10-27',
    issueDate: '2026-10-27',
    currency: 'SAR',
    status: 'draft',
    version: 1,
    validation: { blocking: [], warnings: [] },
  },
  HotelRateSchema: {
    ...base,
    packageId: id,
    hotelId: id2,
    pricingMode: 'derived_per_person',
    roomPriceMinor: 20_000,
    perPersonMinor: { quint: 4000, quad: 5000, triple: 6700, double: 10_000 },
    sourcePage: 1,
    sourceRow: 3,
    confidence: 0.97,
    edited: false,
  },
  VisaRateSchema: {
    ...base,
    packageId: id,
    direct: { perPersonMinor: 55_000 },
    indirectByGroupSize: { '1': 70_000, '2': 67_500, '3': 65_000, '4': 62_500 },
    infantMinor: 46_000,
  },
  FxRateSchema: { ...base, base: 'SAR', quote: 'PKR', rate: '74.50', effectiveAt: now, setBy: id },
  SettingsSchema: { ...base },
  FlightEstimateSchema: {
    ...base,
    originCity: 'Islamabad',
    destination: 'JED',
    lowMinor: 15_000_000,
    highMinor: 21_000_000,
    currency: 'PKR',
    validTo: '2027-01-31',
    source: 'partner quote 2026-11-05',
  },
  CalculationSchema: {
    ...base,
    inputs: {},
    rateVersionSnapshot: [{ packageId: id, version: 1, supplierId: id2, issueDate: '2026-10-27' }],
    fx,
    markupPercent: 0,
    lineItems: [],
    missing: ['Flight: request a quote'],
    assumptions: [],
    exclusions: [],
    totals: { ...totals, isPartial: true },
    expiresAt: now,
    hash: 'abc123',
    engineVersion: '0.0.0',
  },
  TravelerSchema: { ...base, name: 'Test Traveler', phone: '+923001234567', language: 'ur' },
  LeadSchema: {
    ...base,
    reference: 'MSF-2026-000001',
    travelerId: id,
    source: 'calculator',
    status: 'new',
    notes: [],
    consent: { textVersion: 'v1', acceptedAt: now },
    dedupeKey: 'k',
  },
  QuoteSchema: {
    ...base,
    leadId: id,
    version: 1,
    status: 'draft',
    lineItems: [
      {
        description: 'Qila Ajiyad, 3 nights x 4 persons',
        supplier: 'Waqar-e-Madina Group',
        quantity: 12,
        unitAmountMinor: 5000,
        currency: 'SAR',
      },
    ],
    exclusions: [],
    terms: '[LEGAL REVIEW NEEDED]',
    fx,
    totals: { totalMinorPKR: 4_500_000, totalMinorSAR: 60_000 },
    publicTokenHash: 'b'.repeat(64),
    expiresAt: now,
  },
  MessageSchema: { ...base, leadId: id, direction: 'inbound', body: 'Hello', channel: 'site' },
  AuditEventSchema: {
    actorId: id,
    actorRole: 'admin',
    action: 'ratePackage.publish',
    entityType: 'ratePackage',
    entityId: id2,
    at: now,
  },
} as const;

type SchemaName = keyof typeof valid;

describe('collection schemas', () => {
  it('covers all 16 collections in docs/02 section 1', () => {
    expect(Object.keys(valid)).toHaveLength(16);
    for (const name of Object.keys(valid)) expect(schemas).toHaveProperty(name);
  });

  it.each(Object.keys(valid) as SchemaName[])('%s accepts a valid document', (name) => {
    const result = schemas[name].safeParse(valid[name]);
    expect(result.error?.issues).toBeUndefined();
  });

  it('applies settings defaults from docs/02 and docs/05', () => {
    const s = schemas.SettingsSchema.parse(valid.SettingsSchema);
    expect(s.markupPercent).toBe(0);
    expect(s.estimateExpiryHours).toBe(72);
    expect(s.infantHotelCharge).toBe('none');
    expect(s.childAsAdult).toBe(true);
    expect(s.responseTimeText).toBe('within 1 business day');
  });

  it('rejects floating-point and negative money', () => {
    const bad = { ...valid.HotelRateSchema, roomPriceMinor: 200.5 };
    expect(schemas.HotelRateSchema.safeParse(bad).success).toBe(false);
    const neg = { ...valid.VisaRateSchema, infantMinor: -1 };
    expect(schemas.VisaRateSchema.safeParse(neg).success).toBe(false);
  });

  it('rejects unknown roles, statuses and currencies', () => {
    expect(schemas.UserSchema.safeParse({ ...valid.UserSchema, role: 'owner' }).success).toBe(
      false,
    );
    expect(schemas.QuoteSchema.safeParse({ ...valid.QuoteSchema, status: 'booked' }).success).toBe(
      false,
    );
    expect(
      schemas.RatePackageSchema.safeParse({ ...valid.RatePackageSchema, currency: 'USD' }).success,
    ).toBe(false);
  });

  it('rejects nightTo before nightFrom but lets a draft have missing dates', () => {
    const reversed = { ...valid.RatePackageSchema, nightFrom: '2027-02-26', nightTo: '2027-02-06' };
    expect(schemas.RatePackageSchema.safeParse(reversed).success).toBe(false);
    const missing = { ...valid.RatePackageSchema, nightFrom: null, nightTo: null };
    expect(schemas.RatePackageSchema.safeParse(missing).success).toBe(true);
  });

  it('rejects malformed ids, dates, FX rates, references and confidence', () => {
    expect(schemas.HotelSchema.safeParse({ ...valid.HotelSchema, _id: 'nope' }).success).toBe(
      false,
    );
    expect(
      schemas.RatePackageSchema.safeParse({ ...valid.RatePackageSchema, issueDate: '27/10/2026' })
        .success,
    ).toBe(false);
    expect(schemas.FxRateSchema.safeParse({ ...valid.FxRateSchema, rate: 74.5 }).success).toBe(
      false,
    );
    expect(schemas.FxRateSchema.safeParse({ ...valid.FxRateSchema, rate: '0' }).success).toBe(
      false,
    );
    expect(
      schemas.LeadSchema.safeParse({ ...valid.LeadSchema, reference: 'MSF-26-1' }).success,
    ).toBe(false);
    expect(
      schemas.HotelRateSchema.safeParse({ ...valid.HotelRateSchema, confidence: 1.2 }).success,
    ).toBe(false);
  });

  it('rejects a flight estimate whose high is below its low', () => {
    const bad = { ...valid.FlightEstimateSchema, highMinor: 1 };
    expect(schemas.FlightEstimateSchema.safeParse(bad).success).toBe(false);
  });

  it('strips fields we must never collect (hard rule 6)', () => {
    const t = schemas.TravelerSchema.parse({
      ...valid.TravelerSchema,
      passportNumber: 'X',
      cnic: 'Y',
    });
    expect(t).not.toHaveProperty('passportNumber');
    expect(t).not.toHaveProperty('cnic');
  });
});
