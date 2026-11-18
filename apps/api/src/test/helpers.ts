import { readFileSync } from 'node:fs';
import type { Role, SourceDocumentView, SupplierType } from '@marafiq/shared';
import type { Express } from 'express';
import type { Types } from 'mongoose';
import { generate, generateSecret } from 'otplib';
import request, { type Response } from 'supertest';
import type { ExtractionAdapter, ExtractionInput } from '../adapters/extraction/extraction.js';
import { MemoryStorage } from '../adapters/storage/storage.js';
import { createApp } from '../app.js';
import type { AppConfig } from '../config/app-config.js';
import { encryptSecret } from '../lib/crypto.js';
import { DEFAULT_DOCUMENT_PARSER_LIMITS } from '../modules/document-intelligence/document-parser-limits.js';
import { hashPassword } from '../modules/auth/password.js';
import { UserModel, type UserDoc } from '../modules/users/user.model.js';

export const TEST_PASSWORD = 'correct-horse-battery-1';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    jwtSecret: 'test-jwt-secret-test-jwt-secret-0001',
    refreshSecret: 'test-refresh-secret-test-refresh-0002',
    totpKey: Buffer.alloc(32, 7),
    secureCookies: true,
    trustProxy: true, // lets tests pick a client IP with X-Forwarded-For
    accessTtlSeconds: 900,
    refreshTtlSeconds: 7 * 24 * 3600,
    mfaTtlSeconds: 300,
    totpIssuer: 'Marafiq us Safar',
    loginLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000 },
    maxUploadBytes: 20 * 1024 * 1024,
    documentParserLimits: { ...DEFAULT_DOCUMENT_PARSER_LIMITS },
    maxConcurrentDocumentUploads: 2,
    ...overrides,
  };
}

export function makeApp(overrides: Partial<AppConfig> = {}): { app: Express; config: AppConfig } {
  const config = testConfig(overrides);
  return { app: createApp({ config }), config };
}

let counter = 0;

export interface SeededUser {
  user: UserDoc;
  id: string;
  email: string;
  password: string;
  totpSecret?: string;
}

/** Insert a user directly. Admins get an enrolled TOTP secret unless totp is false. */
export async function seedUser(
  options: { role?: Role; email?: string; totp?: boolean; active?: boolean; name?: string } = {},
): Promise<SeededUser> {
  const role = options.role ?? 'sales';
  const email = options.email ?? `${role}${++counter}@example.com`;
  const withTotp = options.totp ?? role === 'admin';
  const totpSecret = withTotp ? generateSecret() : undefined;
  const user = await UserModel.create({
    email,
    name: options.name ?? `Test ${role}`,
    role,
    passwordHash: await hashPassword(TEST_PASSWORD),
    active: options.active ?? true,
    totpSecretEnc: totpSecret ? encryptSecret(totpSecret, testConfig().totpKey) : undefined,
  });
  return { user, id: user.id as string, email, password: TEST_PASSWORD, totpSecret };
}

export function totpCode(secret: string): Promise<string> {
  return generate({ secret });
}

/** Minimal cookie jar. Supertest's agent will not send Secure cookies over http. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(res: Response): this {
    const header = res.headers['set-cookie'] as string[] | string | undefined;
    const lines = Array.isArray(header) ? header : header ? [header] : [];
    for (const line of lines) {
      const [pair = ''] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): this {
    this.cookies.set(name, value);
    return this;
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** Raw Set-Cookie line for one cookie, for asserting flags. */
export function setCookieLine(res: Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  const lines = Array.isArray(header) ? header : header ? [header] : [];
  return lines.find((line) => line.startsWith(`${name}=`));
}

/** Full real sign-in (password, then TOTP when enrolled). Returns the cookie jar. */
export async function signInAs(app: Express, seeded: SeededUser): Promise<CookieJar> {
  const jar = new CookieJar();
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: seeded.email, password: seeded.password });
  jar.absorb(login);
  if (login.body.next === '2fa' && seeded.totpSecret) {
    const second = await request(app)
      .post('/api/v1/auth/2fa')
      .set('Cookie', jar.header())
      .send({ code: await totpCode(seeded.totpSecret) });
    jar.absorb(second);
  }
  if (!jar.get('msf_access')) {
    throw new Error(`sign-in failed for ${seeded.email}: ${JSON.stringify(login.body)}`);
  }
  return jar;
}

export async function signInWithRole(
  app: Express,
  role: Role,
): Promise<{ jar: CookieJar; seeded: SeededUser }> {
  const seeded = await seedUser({ role });
  return { jar: await signInAs(app, seeded), seeded };
}

// --- master data (Phase 2) -------------------------------------------------

export async function seedSupplier(
  overrides: Partial<{ name: string; type: SupplierType; active: boolean }> = {},
): Promise<{ id: string; name: string }> {
  const { SupplierModel } = await import('../modules/suppliers/supplier.model.js');
  const name = overrides.name ?? `Supplier ${++counter}`;
  const doc = await SupplierModel.create({
    name,
    searchName: name.trim().toLowerCase(),
    type: overrides.type ?? 'hotel_operator',
    active: overrides.active ?? true,
  });
  return { id: doc.id as string, name: doc.name };
}

export async function seedHotel(
  overrides: Partial<{
    city: 'makkah' | 'madinah';
    canonicalName: string;
    aliases: string[];
    active: boolean;
  }> = {},
): Promise<{ id: string; canonicalName: string }> {
  const { HotelModel } = await import('../modules/hotels/hotel.model.js');
  const canonicalName = overrides.canonicalName ?? `Hotel ${++counter}`;
  const aliases = overrides.aliases ?? [];
  const doc = await HotelModel.create({
    city: overrides.city ?? 'makkah',
    canonicalName,
    aliases,
    searchNames: [canonicalName, ...aliases].map((name) => name.trim().toLowerCase()),
    distanceNote: '',
    transport: 'unknown',
    active: overrides.active ?? true,
  });
  return { id: doc.id as string, canonicalName: doc.canonicalName };
}

export async function seedFlightEstimate(
  overrides: Partial<{ originCity: string; validTo: string; destination: 'JED' | 'MED' }> = {},
): Promise<{ id: string; originCity: string }> {
  const { FlightEstimateModel } =
    await import('../modules/flight-estimates/flight-estimate.model.js');
  const doc = await FlightEstimateModel.create({
    originCity: overrides.originCity ?? `City ${++counter}`,
    destination: overrides.destination ?? 'JED',
    lowMinor: 15_000_000,
    highMinor: 21_000_000,
    currency: 'PKR',
    validTo: overrides.validTo ?? '2027-12-31',
    source: 'partner quote 2026-11-05',
  });
  return { id: doc.id as string, originCity: doc.originCity };
}

// --- rate sheets (Phase 3) --------------------------------------------------

export const FILE_A = 'WMT_RAMADAN_27_OCT_2026.pdf';
export const FILE_B = 'WMT_RAMADAN_2027_2.pdf';

interface SheetFixture {
  hotels: {
    city: 'makkah' | 'madinah';
    name: string;
    aliasesPrinted: string[];
    distanceText: string | null;
    distanceMeters: number | null;
    transportText: string | null;
  }[];
  extractions: (Record<string, unknown> & { sourceFile: string; packName: string })[];
}

let sheetFixture: SheetFixture | undefined;

/** docs/seed/waqar-sample.json: read from the real WMT sheets. */
export function loadSheetFixture(): SheetFixture {
  sheetFixture ??= JSON.parse(
    readFileSync(new URL('../../../../docs/seed/waqar-sample.json', import.meta.url), 'utf8'),
  ) as SheetFixture;
  return sheetFixture;
}

/** What a correct extraction of one of the two WMT files returns. */
export function fixturePacks(fileName: string): unknown {
  const packs = loadSheetFixture().extractions.filter((e) => e.sourceFile === fileName);
  return structuredClone({ packs });
}

/** Create the 29 hotels of the WMT sheets, as `npm run seed` does. */
export async function seedSheetHotels(): Promise<void> {
  const { createHotel } = await import('../modules/hotels/hotels.service.js');
  for (const hotel of loadSheetFixture().hotels) {
    await createHotel(
      {
        city: hotel.city,
        canonicalName: hotel.name,
        aliases: hotel.aliasesPrinted,
        distanceMeters: hotel.distanceMeters,
        distanceNote: hotel.distanceText ?? '',
        transport: 'unknown',
        starRating: null,
      },
      { role: 'system' },
    );
  }
}

/** Stands in for the Anthropic API. Answers from the fixture by file name. */
export class FixtureExtraction implements ExtractionAdapter {
  readonly model = 'fixture-model';
  readonly calls: ExtractionInput[] = [];
  /** Queue answers (or errors) to return before falling back to the fixture. */
  readonly queue: (unknown | Error)[] = [];

  async extract(input: ExtractionInput): Promise<unknown> {
    this.calls.push(input);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }
    return fixturePacks(input.fileName);
  }
}

/** A tiny file that passes the PDF signature check; unique per label. */
export function fakePdf(label = 'sheet'): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
}

export function makeSheetApp(overrides: Partial<AppConfig> = {}) {
  const storage = new MemoryStorage();
  const extraction = new FixtureExtraction();
  const config = testConfig(overrides);
  const app = createApp({ config, deps: { storage, extraction, inlineJobs: true } });
  return { app, config, storage, extraction };
}

export function uploadSheet(
  app: Express,
  jar: CookieJar,
  options: { supplierId: string; fileName?: string; content?: Buffer; contentType?: string },
) {
  return request(app)
    .post('/api/v1/admin/source-documents')
    .set('Cookie', jar.header())
    .field('supplierId', options.supplierId)
    .attach('file', options.content ?? fakePdf(options.fileName ?? FILE_A), {
      filename: options.fileName ?? FILE_A,
      contentType: options.contentType ?? 'application/pdf',
    });
}

/** Upload a file and run extraction; returns the document with its packs. */
export async function uploadAndExtract(
  app: Express,
  jar: CookieJar,
  supplierId: string,
  fileName: string = FILE_A,
): Promise<SourceDocumentView> {
  const uploaded = await uploadSheet(app, jar, { supplierId, fileName });
  if (uploaded.status !== 201) throw new Error(`upload failed: ${JSON.stringify(uploaded.body)}`);
  const extracted = await request(app)
    .post(`/api/v1/admin/source-documents/${uploaded.body.id}/extract`)
    .set('Cookie', jar.header());
  if (extracted.status >= 300) throw new Error(`extract failed: ${JSON.stringify(extracted.body)}`);
  const doc = await request(app)
    .get(`/api/v1/admin/source-documents/${uploaded.body.id}`)
    .set('Cookie', jar.header());
  return doc.body as SourceDocumentView;
}

/**
 * Records for the permission sweep, written straight to the database:
 * a stored document, a clean pack ready to publish, an unconfirmed row, and a
 * published pack that replaced an earlier one (so it can be rolled back).
 */
export async function seedSheetScenario(
  storage: MemoryStorage,
  ids: { supplierId: string; hotelId: string },
): Promise<{
  documentId: string;
  reviewPackageId: string;
  rateId: string;
  candidateRateId: string;
  rollbackPackageId: string;
}> {
  const models = await import('../modules/rate-sheets/rate-sheet.models.js');
  const today = new Date().toISOString().slice(0, 10);
  const fileKey = `rate-sheets/${ids.supplierId}/${'a'.repeat(64)}.pdf`;
  await storage.put(fileKey, fakePdf('scenario'));
  const doc = await models.SourceDocumentModel.create({
    supplierId: ids.supplierId,
    fileKey,
    fileName: 'scenario.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    receivedAt: new Date(),
    extractionStatus: 'needs_review',
  });

  // Published packs live on a second document, so the first can still be re-read.
  const publishedDoc = await models.SourceDocumentModel.create({
    supplierId: ids.supplierId,
    fileKey,
    fileName: 'published.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'b'.repeat(64),
    receivedAt: new Date(),
    extractionStatus: 'published',
  });

  const pack = (fields: Record<string, unknown>) =>
    models.RatePackageModel.create({
      supplierId: ids.supplierId,
      sourceDocumentId: doc._id,
      packName: 'Scenario Pack',
      issueDate: today,
      status: 'needs_review',
      ...fields,
    });
  const visa = (packageId: Types.ObjectId) =>
    models.VisaRateModel.create({
      packageId,
      direct: { perPersonMinor: 55_000 },
      indirectByGroupSize: { '1': 70_000, '2': 67_500, '3': 65_000, '4': 62_500 },
      infantMinor: 46_000,
    });
  const row = (packageId: Types.ObjectId, hotelId?: string) =>
    models.HotelRateModel.create({
      packageId,
      hotelId,
      printed: { city: 'makkah', name: hotelId ? 'Known Hotel' : 'Brand New Hotel' },
      pricingMode: 'derived_per_person',
      roomPriceMinor: 20_000,
      perPersonMinor: { quint: 4000, quad: 5000, triple: 6700, double: 10_000 },
    });

  const review = await pack({ nightFrom: '2030-01-01', nightTo: '2030-01-10' });
  await visa(review._id);
  const rate = await row(review._id, ids.hotelId);

  const withCandidate = await pack({ nightFrom: '2030-02-01', nightTo: '2030-02-10' });
  await visa(withCandidate._id);
  const candidate = await row(withCandidate._id);

  const old = await pack({
    sourceDocumentId: publishedDoc._id,
    nightFrom: '2030-03-01',
    nightTo: '2030-03-10',
    status: 'superseded',
  });
  await visa(old._id);
  await row(old._id, ids.hotelId);
  const current = await pack({
    sourceDocumentId: publishedDoc._id,
    nightFrom: '2030-03-01',
    nightTo: '2030-03-10',
    status: 'published',
    version: 2,
    supersedesId: old._id,
    publishedAt: new Date(),
  });
  await visa(current._id);
  await row(current._id, ids.hotelId);

  return {
    documentId: doc.id as string,
    reviewPackageId: review.id as string,
    rateId: rate.id as string,
    candidateRateId: candidate.id as string,
    rollbackPackageId: current.id as string,
  };
}
