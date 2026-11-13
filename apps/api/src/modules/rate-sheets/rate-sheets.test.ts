/**
 * Upload -> extract -> review -> publish, driven through the API with a
 * fixture in place of the Anthropic call. The fixture is the real WMT sheets
 * (docs/seed/waqar-sample.json). Covers T9 and T10 from docs/03 section 7.
 */
import type { RatePackageDetail, SourceDocumentView } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExtractionFormatError } from '../../adapters/extraction/extraction.js';
import type { MemoryStorage } from '../../adapters/storage/storage.js';
import {
  CookieJar,
  FILE_A,
  FILE_B,
  FixtureExtraction,
  fakePdf,
  fixturePacks,
  makeSheetApp,
  seedHotel,
  seedSheetHotels,
  seedSupplier,
  seedUser,
  signInAs,
  uploadAndExtract,
  uploadSheet,
} from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { HotelModel } from '../hotels/hotel.model.js';
import { HotelRateModel, RatePackageModel, SourceDocumentModel } from './rate-sheet.models.js';

const DOCS = '/api/v1/admin/source-documents';
const PACKS = '/api/v1/admin/rate-packages';
const RATES = '/api/v1/admin/hotel-rates';

let app: Express;
let jar: CookieJar;
let storage: MemoryStorage;
let extraction: FixtureExtraction;
let supplierId: string;
let opsId: string;

beforeEach(async () => {
  ({ app, storage, extraction } = makeSheetApp());
  const ops = await seedUser({ role: 'ops' });
  opsId = ops.id;
  jar = await signInAs(app, ops);
  supplierId = (await seedSupplier({ name: 'Waqar-e-Madina Group (WMT)' })).id;
  await seedSheetHotels();
});

const get = (url: string) => request(app).get(url).set('Cookie', jar.header());
const post = (url: string, body: object = {}) =>
  request(app).post(url).set('Cookie', jar.header()).send(body);
const patch = (url: string, body: object) =>
  request(app).patch(url).set('Cookie', jar.header()).send(body);

async function detail(packageId: string): Promise<RatePackageDetail> {
  return (await get(`${PACKS}/${packageId}`)).body as RatePackageDetail;
}

function packNamed(doc: SourceDocumentView, name: string): string {
  const pack = doc.packages.find((p) => p.packName === name);
  if (!pack) throw new Error(`no pack ${name}`);
  return pack.id;
}

const rowFor = (pack: RatePackageDetail, hotelName: string) => {
  const row = pack.rates.find((r) => r.hotelName === hotelName || r.printed.name === hotelName);
  if (!row) throw new Error(`no row ${hotelName}`);
  return row;
};

const publish = (packageId: string, acknowledgeWarnings = true) =>
  post(`${PACKS}/${packageId}/publish`, { acknowledgeWarnings });

describe('upload', () => {
  it('stores the original file and records the document', async () => {
    const content = fakePdf('first');
    const res = await uploadSheet(app, jar, { supplierId, content });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      supplierId,
      fileName: FILE_A,
      mimeType: 'application/pdf',
      extractionStatus: 'uploaded',
      packages: [],
    });
    const stored = await SourceDocumentModel.findById(res.body.id).lean();
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(String(stored?.uploadedBy)).toBe(opsId);
    expect(await storage.get(stored?.fileKey as string)).toEqual(content);
    // The key never contains the uploaded file name.
    expect(stored?.fileKey).not.toContain('WMT');

    const [event] = await AuditEventModel.find({ action: 'sourceDocument.upload' }).lean();
    expect(String(event?.entityId)).toBe(res.body.id);
  });

  it('T9: rejects an exact duplicate with a link to the existing record', async () => {
    const content = fakePdf('same bytes');
    const first = await uploadSheet(app, jar, { supplierId, content });
    const second = await uploadSheet(app, jar, { supplierId, content, fileName: 'renamed.pdf' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('duplicate_document');
    expect(second.body.error.fields.existingId).toBe(first.body.id);
    expect(await SourceDocumentModel.countDocuments()).toBe(1);
  });

  it('accepts the same file for a different supplier', async () => {
    const content = fakePdf('shared');
    await uploadSheet(app, jar, { supplierId, content });
    const other = await seedSupplier();
    const res = await uploadSheet(app, jar, { supplierId: other.id, content });
    expect(res.status).toBe(201);
  });

  it('rejects files that are not really a PDF, PNG or JPEG', async () => {
    const disguised = await uploadSheet(app, jar, {
      supplierId,
      content: Buffer.from('<html>not a pdf</html>'),
    });
    expect(disguised.status).toBe(400);
    expect(disguised.body.error.code).toBe('unsupported_file');

    const spreadsheet = await uploadSheet(app, jar, {
      supplierId,
      fileName: 'rates.xlsx',
      contentType: 'application/vnd.ms-excel',
      content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), // a zip, as .xlsx files are
    });
    expect(spreadsheet.status).toBe(400);

    // The bytes decide, not the name or the browser's claim.
    const mislabelled = await uploadSheet(app, jar, {
      supplierId,
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
      content: fakePdf('really a pdf'),
    });
    expect(mislabelled.status).toBe(201);
    expect(mislabelled.body.mimeType).toBe('application/pdf');
  });

  it('accepts a PNG and a JPEG photo', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('x'),
    ]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('y')]);
    const a = await uploadSheet(app, jar, {
      supplierId,
      content: png,
      fileName: 'a.png',
      contentType: 'image/png',
    });
    const b = await uploadSheet(app, jar, {
      supplierId,
      content: jpeg,
      fileName: 'b.jpg',
      contentType: 'image/jpeg',
    });
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  it('rejects a missing file, an unknown supplier and an oversized file', async () => {
    const noFile = await request(app)
      .post(DOCS)
      .set('Cookie', jar.header())
      .field('supplierId', supplierId);
    expect(noFile.status).toBe(400);

    const noSupplier = await uploadSheet(app, jar, { supplierId: '64b7f0c2a1b2c3d4e5f60718' });
    expect(noSupplier.status).toBe(404);

    const small = makeSheetApp({ maxUploadBytes: 64 });
    const smallJar = await signInAs(small.app, await seedUser({ role: 'ops' }));
    const tooBig = await uploadSheet(small.app, smallJar, {
      supplierId,
      content: Buffer.concat([fakePdf(), Buffer.alloc(200)]),
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('file_too_large');
  });

  it('serves the original back to staff only', async () => {
    const content = fakePdf('original');
    const uploaded = await uploadSheet(app, jar, { supplierId, content });
    const res = await get(`${DOCS}/${uploaded.body.id}/file`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toEqual(content);

    expect((await request(app).get(`${DOCS}/${uploaded.body.id}/file`)).status).toBe(401);
  });
});

describe('extraction', () => {
  it('turns one file into three packs awaiting review, with every hotel matched', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);

    expect(doc.extractionStatus).toBe('needs_review');
    expect(doc.extractionModel).toBe('fixture-model');
    expect(doc.packages.map((p) => p.packName).sort()).toEqual([
      'Ramadan Pack 01',
      'Ramadan Pack 02',
      'Shawal',
    ]);
    expect(doc.packages.every((p) => p.status === 'needs_review')).toBe(true);

    const pack = await detail(packNamed(doc, 'Ramadan Pack 01'));
    expect(pack).toMatchObject({
      nightFrom: '2027-02-06',
      nightTo: '2027-02-26',
      issueDate: '2026-10-27',
      effectiveFrom: '2026-10-27',
      currency: 'SAR',
      version: 1,
    });
    expect(pack.rates).toHaveLength(29);
    expect(pack.rates.every((r) => r.hotelId !== null)).toBe(true);
    expect(pack.validation.blocking).toEqual([]);
  });

  it('stores amounts as integer halalas exactly as printed', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack = await detail(packNamed(doc, 'Ramadan Pack 01'));

    expect(rowFor(pack, 'Qila Ajiyad')).toMatchObject({
      pricingMode: 'derived_per_person',
      roomPriceMinor: 20_000,
      perPersonMinor: { quint: 4000, quad: 5000, triple: 6700, double: 10_000 },
      edited: false,
    });
    expect(rowFor(pack, 'Waqar Salmiya/Jood Marjan').perPersonMinor.quad).toBe(5400);
    expect(pack.visa).toMatchObject({
      directPerPersonMinor: 55_000,
      indirectByGroupSizeMinor: { '1': 70_000, '2': 67_500, '3': 65_000, '4': 62_500 },
      infantMinor: 46_000,
    });
  });

  it('converts decimal SAR amounts to halalas without rounding excessive precision', async () => {
    const answer = fixturePacks(FILE_A) as {
      packs: {
        hotels: { name: string; room: number | null }[];
      }[];
    };

    const hotels = answer.packs[0]!.hotels;
    hotels[2]!.room = 12;
    hotels[4]!.room = 12.5;
    hotels[11]!.room = 12.345;

    extraction.queue.push(answer);

    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack = await detail(packNamed(doc, 'Ramadan Pack 01'));

    expect(rowFor(pack, 'Qila Ajiyad').roomPriceMinor).toBe(1200);
    expect(rowFor(pack, 'Fundaq Bilal').roomPriceMinor).toBe(1250);
    expect(rowFor(pack, 'Voco').roomPriceMinor).toBeNull();
  });

  it('reads each row type: flat room, room basis, on booking', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack01 = await detail(packNamed(doc, 'Ramadan Pack 01'));
    const pack02 = await detail(packNamed(doc, 'Ramadan Pack 02'));

    expect(rowFor(pack01, 'Fundaq Bilal')).toMatchObject({
      pricingMode: 'flat_per_room',
      roomPriceMinor: 20_000,
    });
    // Room basis: priced from the ROOM column; printed figures kept for reference.
    expect(rowFor(pack01, 'Akabir Hijrah/Areej Wafa/Mather Elite')).toMatchObject({
      pricingMode: 'flat_per_room',
      roomPriceMinor: 60_000,
      perPersonMinor: { quint: null, quad: 15_000, triple: 20_000, double: 30_000 },
    });
    expect(rowFor(pack01, 'Voco')).toMatchObject({
      pricingMode: 'on_request',
      roomPriceMinor: null,
    });
    // The same hotel changes type between packs; nothing is carried over.
    expect(rowFor(pack01, 'Al Kiswah Tower').pricingMode).toBe('flat_per_room');
    expect(rowFor(pack02, 'Al Kiswah Tower').pricingMode).toBe('on_request');
  });

  it('flags flat-room rows for confirmation the first time they are seen', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack = await detail(packNamed(doc, 'Ramadan Pack 01'));
    const flagged = pack.validation.warnings.filter((w) => w.code === 'flat_first_seen');
    expect(flagged).toHaveLength(3); // Fundaq Bilal, Akabir Hijrah, Al Kiswah Tower
  });

  it('matches a hotel printed under its old name', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId, FILE_B);
    const pack = await detail(packNamed(doc, 'Ramadan Pack 01'));
    const row = rowFor(pack, 'RETAJ RAWDAH');
    expect(row.hotelName).toBe('Rose Platinum');
    expect(row.hotelId).not.toBeNull();
  });

  it('leaves an unknown name for staff, suggesting a close match but never applying it', async () => {
    const answer = fixturePacks(FILE_A) as { packs: { hotels: { name: string }[] }[] };
    const pack01 = answer.packs[0]!;
    pack01.hotels[2]!.name = 'QILA AJYAD'; // one letter off "Qila Ajiyad"
    pack01.hotels[3]!.name = 'COMPLETELY NEW PALACE';
    extraction.queue.push(answer);

    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack = await detail(packNamed(doc, 'Ramadan Pack 01'));

    const close = rowFor(pack, 'QILA AJYAD');
    expect(close.hotelId).toBeNull();
    expect(close.suggestedHotelName).toBe('Qila Ajiyad');

    const unknown = rowFor(pack, 'COMPLETELY NEW PALACE');
    expect(unknown.hotelId).toBeNull();
    expect(unknown.suggestedHotelId).toBeNull();

    const unconfirmed = pack.validation.blocking.filter((b) => b.code === 'hotel_unconfirmed');
    expect(unconfirmed.map((b) => b.path).sort()).toEqual(
      [`rate:${close.id}`, `rate:${unknown.id}`].sort(),
    );
  });

  it('retries once with the validation error when the answer does not fit the schema', async () => {
    extraction.queue.push({ packs: [{ packName: 'Broken', hotels: 'not-a-list' }] });
    const doc = await uploadAndExtract(app, jar, supplierId);

    expect(extraction.calls).toHaveLength(2);
    expect(extraction.calls[0]?.previousError).toBeUndefined();
    expect(extraction.calls[1]?.previousError).toMatch(/hotels|currency|visa/);
    expect(doc.packages).toHaveLength(3);
  });

  it('gives up after the retry and tells staff to enter it by hand or retry', async () => {
    extraction.queue.push({ nonsense: true }, new ExtractionFormatError('not JSON'));
    const doc = await uploadAndExtract(app, jar, supplierId);

    expect(extraction.calls).toHaveLength(2);
    expect(doc.extractionStatus).toBe('needs_review');
    expect(doc.extractionError).toBe('Extraction failed — enter manually or retry');
    expect(doc.packages).toEqual([]);

    // Retrying afterwards works.
    await post(`${DOCS}/${doc.id}/extract`);
    const again = (await get(`${DOCS}/${doc.id}`)).body as SourceDocumentView;
    expect(again.extractionError).toBeNull();
    expect(again.packages).toHaveLength(3);
  });

  it('does not retry when the service itself fails', async () => {
    extraction.queue.push(new Error('connect ETIMEDOUT secret-host'));
    const doc = await uploadAndExtract(app, jar, supplierId);
    expect(extraction.calls).toHaveLength(1);
    expect(doc.extractionError).toBe('Extraction failed — enter manually or retry');
    expect(JSON.stringify(doc)).not.toContain('secret-host');
  });

  it('keeps the raw model output but never returns it from the API', async () => {
    const answer = fixturePacks(FILE_A) as { packs: { supplierName: string }[] };
    answer.packs[0]!.supplierName = 'RAW-OUTPUT-MARKER';
    extraction.queue.push(answer);
    const doc = await uploadAndExtract(app, jar, supplierId);

    const stored = await SourceDocumentModel.findById(doc.id).lean();
    expect(JSON.stringify(stored?.extractionRaw)).toContain('RAW-OUTPUT-MARKER');

    const bodies = [
      (await get(DOCS)).body,
      (await get(`${DOCS}/${doc.id}`)).body,
      (await get(PACKS)).body,
      await detail(doc.packages[0]!.id),
      (await request(app).get('/api/v1/public/config')).body,
    ];
    expect(JSON.stringify(bodies)).not.toContain('RAW-OUTPUT-MARKER');
    expect(JSON.stringify(bodies)).not.toContain('extractionRaw');
  });

  it('extracting again replaces the unpublished packs of that document', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);
    await post(`${DOCS}/${doc.id}/extract`);
    const again = (await get(`${DOCS}/${doc.id}`)).body as SourceDocumentView;

    expect(again.packages.filter((p) => p.status === 'needs_review')).toHaveLength(3);
    expect(await RatePackageModel.countDocuments({ status: 'rejected' })).toBe(3);
  });

  it('answers 503 when no extraction service is configured', async () => {
    const { createApp } = await import('../../app.js');
    const { testConfig } = await import('../../test/helpers.js');
    const bare = createApp({ config: testConfig(), deps: { storage, inlineJobs: true } });
    const bareJar = await signInAs(bare, await seedUser({ role: 'ops' }));
    const uploaded = await uploadSheet(bare, bareJar, { supplierId, content: fakePdf('bare') });
    const res = await request(bare)
      .post(`${DOCS}/${uploaded.body.id}/extract`)
      .set('Cookie', bareJar.header());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('extraction_not_configured');
  });
});

describe('review', () => {
  let doc: SourceDocumentView;
  let packId: string;

  beforeEach(async () => {
    doc = await uploadAndExtract(app, jar, supplierId);
    packId = packNamed(doc, 'Ramadan Pack 01');
  });

  it('editing a cell marks the row as edited and re-validates the pack', async () => {
    const row = rowFor(await detail(packId), 'Qila Ajiyad');

    const broken = await patch(`${RATES}/${row.id}`, { roomPriceMinor: null });
    expect(broken.status).toBe(200);
    expect(broken.body.validation.blocking).toContainEqual(
      expect.objectContaining({ code: 'derived_without_room', path: `rate:${row.id}` }),
    );
    expect(rowFor(broken.body as RatePackageDetail, 'Qila Ajiyad').edited).toBe(true);

    const fixed = await patch(`${RATES}/${row.id}`, { roomPriceMinor: 20_000 });
    expect(fixed.body.validation.blocking).toEqual([]);

    const [event] = await AuditEventModel.find({ action: 'hotelRate.update' })
      .sort({ at: 1 })
      .lean();
    expect(event?.before).toMatchObject({ roomPriceMinor: 20_000 });
    expect(event?.after).toMatchObject({ roomPriceMinor: null, edited: true });
  });

  it('warns when an edited figure no longer matches the room price', async () => {
    const row = rowFor(await detail(packId), 'Qila Ajiyad');
    const res = await patch(`${RATES}/${row.id}`, { perPersonMinor: { triple: 9900 } });
    expect(res.body.validation.warnings).toContainEqual(
      expect.objectContaining({ code: 'derived_mismatch', path: `rate:${row.id}` }),
    );
    // Other figures on the row are untouched.
    expect(rowFor(res.body as RatePackageDetail, 'Qila Ajiyad').perPersonMinor).toEqual({
      quint: 4000,
      quad: 5000,
      triple: 9900,
      double: 10_000,
    });
  });

  it('rejects floats and negative money', async () => {
    const row = rowFor(await detail(packId), 'Qila Ajiyad');
    expect((await patch(`${RATES}/${row.id}`, { roomPriceMinor: 200.5 })).status).toBe(400);
    expect((await patch(`${RATES}/${row.id}`, { roomPriceMinor: -1 })).status).toBe(400);
  });

  it('edits the header and visa block', async () => {
    const res = await patch(`${PACKS}/${packId}`, {
      issueDate: '2026-11-01',
      visa: { directPerPersonMinor: 56_000, indirectByGroupSizeMinor: { '2': null } },
    });
    expect(res.status).toBe(200);
    expect(res.body.issueDate).toBe('2026-11-01');
    expect(res.body.visa.directPerPersonMinor).toBe(56_000);
    expect(res.body.visa.indirectByGroupSizeMinor).toEqual({
      '1': 70_000,
      '2': null,
      '3': 65_000,
      '4': 62_500,
    });
    expect(res.body.validation.blocking.map((b: { code: string }) => b.code)).toContain(
      'visa_missing',
    );
  });

  it('blocks reversed dates entered by hand', async () => {
    const res = await patch(`${PACKS}/${packId}`, { nightFrom: '2027-03-01' });
    expect(res.body.validation.blocking.map((b: { code: string }) => b.code)).toContain(
      'dates_reversed',
    );
  });

  it('adds a row by hand and removes a row from a draft', async () => {
    const extra = await seedHotel({ city: 'makkah', canonicalName: 'Hand Added Hotel' });
    const added = await post(`${PACKS}/${packId}/hotel-rates`, {
      hotelId: extra.id,
      pricingMode: 'flat_per_room',
      roomPriceMinor: 45_000,
    });
    expect(added.status).toBe(201);
    const row = rowFor(added.body as RatePackageDetail, 'Hand Added Hotel');
    expect(row).toMatchObject({ edited: true, roomPriceMinor: 45_000, confidence: 1 });

    const duplicate = await post(`${PACKS}/${packId}/hotel-rates`, {
      hotelId: extra.id,
      pricingMode: 'on_request',
    });
    expect(duplicate.status).toBe(409);

    const removed = await request(app).delete(`${RATES}/${row.id}`).set('Cookie', jar.header());
    expect(removed.status).toBe(200);
    expect((removed.body as RatePackageDetail).rates).toHaveLength(29);
    expect(await AuditEventModel.countDocuments({ action: 'hotelRate.delete' })).toBe(1);
  });
});

describe('confirming hotels', () => {
  async function packWithUnknown(name: string) {
    const answer = fixturePacks(FILE_A) as {
      packs: { hotels: { name: string; aliasesPrinted: string[] }[] }[];
    };
    answer.packs[0]!.hotels[2]!.name = name;
    extraction.queue.push(answer);
    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack = await detail(packNamed(doc, 'Ramadan Pack 01'));
    return { pack, row: rowFor(pack, name) };
  }

  it('creates a new hotel from what the sheet prints', async () => {
    const { row } = await packWithUnknown('GRAND NEW TOWER');
    const res = await post(`${RATES}/${row.id}/confirm-hotel`, { action: 'create' });

    expect(res.status).toBe(200);
    const confirmed = rowFor(res.body as RatePackageDetail, 'GRAND NEW TOWER');
    expect(confirmed.hotelName).toBe('GRAND NEW TOWER');
    expect(res.body.validation.blocking).toEqual([]);

    const hotel = await HotelModel.findById(confirmed.hotelId).lean();
    expect(hotel).toMatchObject({ city: 'makkah', canonicalName: 'GRAND NEW TOWER', active: true });
  });

  it('maps the name to an existing hotel and remembers it as an alias', async () => {
    const { row } = await packWithUnknown('QILA AJYAD');
    const qila = await HotelModel.findOne({ canonicalName: 'Qila Ajiyad' });

    const res = await post(`${RATES}/${row.id}/confirm-hotel`, {
      action: 'map',
      hotelId: qila?.id as string,
    });
    expect(res.status).toBe(200);
    expect(rowFor(res.body as RatePackageDetail, 'QILA AJYAD').hotelName).toBe('Qila Ajiyad');
    expect((await HotelModel.findById(qila?.id).lean())?.aliases).toContain('QILA AJYAD');

    // Next time the same spelling arrives, it matches by itself.
    const answer = fixturePacks(FILE_B) as { packs: { hotels: { name: string }[] }[] };
    answer.packs[0]!.hotels[2]!.name = 'QILA AJYAD';
    extraction.queue.push(answer);
    const next = await uploadAndExtract(app, jar, supplierId, FILE_B);
    const nextPack = await detail(packNamed(next, 'Ramadan Pack 01'));
    expect(rowFor(nextPack, 'QILA AJYAD').hotelId).toBe(qila?.id);
  });

  it('refuses to map to a hotel in the other city or one already in the pack', async () => {
    const { row } = await packWithUnknown('SOMEWHERE ELSE');
    const madinah = await HotelModel.findOne({ canonicalName: 'Waqar Rotana' });
    const wrongCity = await post(`${RATES}/${row.id}/confirm-hotel`, {
      action: 'map',
      hotelId: madinah?.id as string,
    });
    expect(wrongCity.status).toBe(400);

    const diyar = await HotelModel.findOne({ canonicalName: 'Diyar Mather' });
    const taken = await post(`${RATES}/${row.id}/confirm-hotel`, {
      action: 'map',
      hotelId: diyar?.id as string,
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('hotel_already_in_pack');
  });
});

describe('publishing', () => {
  let doc: SourceDocumentView;
  let pack01: string;

  beforeEach(async () => {
    doc = await uploadAndExtract(app, jar, supplierId);
    pack01 = packNamed(doc, 'Ramadan Pack 01');
  });

  it('is blocked while any blocking error exists', async () => {
    const row = rowFor(await detail(pack01), 'Qila Ajiyad');
    await patch(`${RATES}/${row.id}`, { roomPriceMinor: null });

    const res = await publish(pack01);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('blocking_errors');
    expect((await detail(pack01)).status).toBe('needs_review');
  });

  it('needs the warnings acknowledged, then publishes', async () => {
    const unacknowledged = await publish(pack01, false);
    expect(unacknowledged.status).toBe(409);
    expect(unacknowledged.body.error.code).toBe('warnings_not_acknowledged');

    const res = await publish(pack01);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'published',
      version: 1,
      publishedByName: 'Test ops',
    });
    expect(res.body.publishedAt).toBeTruthy();

    const stored = (await get(`${DOCS}/${doc.id}`)).body as SourceDocumentView;
    expect(stored.extractionStatus).toBe('published');

    const [event] = await AuditEventModel.find({ action: 'ratePackage.publish' }).lean();
    expect(String(event?.actorId)).toBe(opsId);
    expect(event?.before).toMatchObject({ status: 'needs_review' });
    expect(event?.after).toMatchObject({ status: 'published', version: 1 });
  });

  it('a published pack can no longer be edited', async () => {
    await publish(pack01);
    const row = rowFor(await detail(pack01), 'Qila Ajiyad');

    const edit = await patch(`${RATES}/${row.id}`, { roomPriceMinor: 1 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('not_editable');
    expect((await patch(`${PACKS}/${pack01}`, { packName: 'Changed' })).status).toBe(409);
    expect(
      (await request(app).delete(`${RATES}/${row.id}`).set('Cookie', jar.header())).status,
    ).toBe(409);
    expect((await publish(pack01)).status).toBe(409);
    expect((await HotelRateModel.findById(row.id).lean())?.roomPriceMinor).toBe(20_000);
  });

  it('three packs with back-to-back nights publish side by side', async () => {
    for (const name of ['Ramadan Pack 01', 'Ramadan Pack 02', 'Shawal']) {
      expect((await publish(packNamed(doc, name))).status).toBe(200);
    }
    expect(await RatePackageModel.countDocuments({ status: 'published' })).toBe(3);
  });

  it('warns about big price moves against the previous pack of the season', async () => {
    await publish(pack01);
    const pack02 = await post(`${PACKS}/${packNamed(doc, 'Ramadan Pack 02')}/validate`);
    const moved = pack02.body.validation.warnings.filter(
      (w: { code: string }) => w.code === 'price_change',
    );
    // Qila Ajiyad room 200 -> 350 is one of many.
    expect(moved.some((w: { message: string }) => w.message.includes('Qila Ajiyad'))).toBe(true);
  });

  it('a newer sheet for the same nights must be marked as a replacement, then supersedes', async () => {
    await publish(pack01);
    const newer = await uploadAndExtract(app, jar, supplierId, FILE_B);
    const replacement = packNamed(newer, 'Ramadan Pack 01');

    const blocked = await publish(replacement);
    expect(blocked.status).toBe(409);
    expect((await detail(replacement)).validation.blocking.map((b) => b.code)).toContain(
      'overlaps_published',
    );
    expect((await detail(replacement)).replaceable.map((p) => p.id)).toContain(pack01);

    await patch(`${PACKS}/${replacement}`, { supersedesId: pack01 });
    const res = await publish(replacement);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'published', version: 2, supersedesId: pack01 });

    // The old pack is kept, never overwritten.
    const old = await detail(pack01);
    expect(old.status).toBe('superseded');
    expect(old.rates).toHaveLength(29);
    expect(await AuditEventModel.countDocuments({ action: 'ratePackage.supersede' })).toBe(1);
  });

  it('refuses to mark an unpublished or foreign pack as the one being replaced', async () => {
    const pack02 = packNamed(doc, 'Ramadan Pack 02');
    expect((await patch(`${PACKS}/${pack01}`, { supersedesId: pack02 })).status).toBe(400);
    expect((await patch(`${PACKS}/${pack01}`, { supersedesId: pack01 })).status).toBe(400);
  });

  it('T10: same pack dates with a different issue date is flagged and cannot publish unacknowledged', async () => {
    const other = await uploadAndExtract(app, jar, supplierId, FILE_B);
    const shawal17 = packNamed(other, 'Shawal'); // issued 17-OCT-2026
    const shawal27 = packNamed(doc, 'Shawal'); // issued 27-OCT-2026

    const first = await detail(shawal17);
    expect(first.issueDate).toBe('2026-10-17');
    expect(first.validation.warnings.map((w) => w.code)).toContain('same_dates_other_issue_date');

    // The pack extracted earlier learns about the conflict when it is next validated.
    const second = await post(`${PACKS}/${shawal27}/validate`);
    expect(second.body.validation.warnings.map((w: { code: string }) => w.code)).toContain(
      'same_dates_other_issue_date',
    );

    const res = await publish(shawal17, false);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('warnings_not_acknowledged');
    expect((await detail(shawal17)).status).toBe('needs_review');
  });

  it('rejects a pack, which frees its nights', async () => {
    const res = await post(`${PACKS}/${pack01}/reject`, { reason: 'Wrong season' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect((await publish(pack01)).status).toBe(409);

    const [event] = await AuditEventModel.find({ action: 'ratePackage.reject' }).lean();
    expect(event?.after).toMatchObject({ status: 'rejected', reason: 'Wrong season' });
  });
});

describe('rollback', () => {
  it('republishes the previous version as a new version', async () => {
    const first = await uploadAndExtract(app, jar, supplierId);
    const original = packNamed(first, 'Ramadan Pack 01');
    await publish(original);

    const answer = fixturePacks(FILE_B) as {
      packs: { hotels: { name: string; room: number }[] }[];
    };
    answer.packs[0]!.hotels[2]!.room = 999; // the newer sheet changes Qila Ajiyad
    extraction.queue.push(answer);
    const second = await uploadAndExtract(app, jar, supplierId, FILE_B);
    const replacement = packNamed(second, 'Ramadan Pack 01');
    await patch(`${PACKS}/${replacement}`, { supersedesId: original });
    await publish(replacement);
    expect((await detail(replacement)).canRollback).toBe(true);

    const res = await post(`${PACKS}/${replacement}/rollback`);
    expect(res.status).toBe(200);
    const restored = res.body as RatePackageDetail;

    expect(restored.id).not.toBe(original);
    expect(restored.id).not.toBe(replacement);
    expect(restored).toMatchObject({ status: 'published', version: 3, supersedesId: replacement });
    expect(restored.rates).toHaveLength(29);
    expect(rowFor(restored, 'Qila Ajiyad').roomPriceMinor).toBe(20_000); // the original price
    expect(restored.visa.directPerPersonMinor).toBe(55_000);

    expect((await detail(replacement)).status).toBe('superseded');
    expect((await detail(original)).status).toBe('superseded'); // history untouched
    expect(
      await RatePackageModel.countDocuments({ status: 'published', nightFrom: '2027-02-06' }),
    ).toBe(1);
    expect(await AuditEventModel.countDocuments({ action: 'ratePackage.rollback' })).toBe(1);
  });

  it('is refused when there is no previous version', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack = packNamed(doc, 'Ramadan Pack 01');
    await publish(pack);
    expect((await detail(pack)).canRollback).toBe(false);
    const res = await post(`${PACKS}/${pack}/rollback`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('nothing_to_roll_back');
  });
});

describe('merging hotels that have rates', () => {
  it('moves the rate rows to the surviving hotel', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);
    const pack = packNamed(doc, 'Ramadan Pack 01');
    const qila = await HotelModel.findOne({ canonicalName: 'Qila Ajiyad' });
    const keeper = await seedHotel({ city: 'makkah', canonicalName: 'Qila Ajiyad Hotel' });

    const res = await post(`/api/v1/admin/hotels/${qila?.id}/merge`, { targetId: keeper.id });
    expect(res.status).toBe(200);

    expect(await HotelRateModel.countDocuments({ hotelId: qila?._id })).toBe(0);
    expect(await HotelRateModel.countDocuments({ hotelId: keeper.id })).toBe(3); // one per pack
    expect(rowFor(await detail(pack), 'Qila Ajiyad Hotel').roomPriceMinor).toBe(20_000);
  });

  it('refuses when both hotels are priced in the same pack', async () => {
    await uploadAndExtract(app, jar, supplierId);
    const qila = await HotelModel.findOne({ canonicalName: 'Qila Ajiyad' });
    const diyar = await HotelModel.findOne({ canonicalName: 'Diyar Mather' });

    const res = await post(`/api/v1/admin/hotels/${qila?.id}/merge`, { targetId: diyar?.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('merge_conflict_rates');
    expect((await HotelModel.findById(qila?.id).lean())?.active).toBe(true);
  });
});

describe('listing', () => {
  it('lists documents and packs, filtered by status', async () => {
    const doc = await uploadAndExtract(app, jar, supplierId);
    await publish(packNamed(doc, 'Shawal'));

    const docs = await get(DOCS);
    expect(docs.body.total).toBe(1);
    expect(docs.body.items[0].packages).toHaveLength(3);

    const published = await get(`${PACKS}?status=published`);
    expect(published.body.items.map((p: { packName: string }) => p.packName)).toEqual(['Shawal']);
    expect((await get(`${PACKS}?status=bogus`)).status).toBe(400);
  });

  it('starts a blank pack for entering a sheet by hand', async () => {
    const uploaded = await uploadSheet(app, jar, { supplierId, content: fakePdf('manual') });
    const res = await post(`${DOCS}/${uploaded.body.id}/rate-packages`, {
      packName: 'Typed In Pack',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      packName: 'Typed In Pack',
      status: 'needs_review',
      rates: [],
    });
    expect(res.body.validation.blocking.map((b: { code: string }) => b.code)).toEqual(
      expect.arrayContaining(['missing_dates', 'visa_missing']),
    );
  });
});
