import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentEvidenceModel } from './document-evidence.models.js';
import { DocumentProcessingJobModel } from './document-processing.models.js';
import { DEFAULT_DOCUMENT_PARSER_LIMITS } from './document-parser-limits.js';
import { startDocumentProcessingWorker } from './document-processing.worker.js';
import { SourceDocumentModel } from '../rate-sheets/rate-sheet.models.js';
import {
  fakePdf,
  makeSheetApp,
  seedSupplier,
  seedUser,
  signInAs,
  type CookieJar,
} from '../../test/helpers.js';

const INTAKE = '/api/v1/admin/document-intelligence/source-documents';

function png(): Buffer {
  const image = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(10, 16);
  image.writeUInt32BE(10, 20);
  return image;
}

function jpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x0a, 0x03, 0x01, 0x11, 0x00, 0x02,
    0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
}

async function xlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Rates').getCell('A1').value = 'Room';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('additive document-intelligence intake routes', () => {
  let app: ReturnType<typeof makeSheetApp>['app'];
  let storage: ReturnType<typeof makeSheetApp>['storage'];
  let jar: CookieJar;
  let supplierId: string;

  beforeEach(async () => {
    ({ app, storage } = makeSheetApp());
    supplierId = (await seedSupplier()).id;
    jar = await signInAs(app, await seedUser({ role: 'ops' }));
  });

  async function upload(file: Buffer, name: string) {
    return request(app)
      .post(INTAKE)
      .set('Cookie', jar.header())
      .field('supplierId', supplierId)
      .attach('file', file, { filename: name });
  }

  it('accepts supported document formats and enqueues without creating pricing records', async () => {
    const cases = [
      { file: fakePdf('digital text'), name: 'supplier.pdf', mimeType: 'application/pdf' },
      { file: png(), name: 'scan.png', mimeType: 'image/png' },
      { file: jpeg(), name: 'photo.jpg', mimeType: 'image/jpeg' },
      {
        file: await xlsx(),
        name: 'rates.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { file: Buffer.from('Room,Rate\nDouble,250'), name: 'rates.csv', mimeType: 'text/csv' },
    ];

    for (const item of cases) {
      const response = await upload(item.file, item.name);
      expect(response.status).toBe(201);
      expect(response.body.processing).toMatchObject({
        status: 'queued',
        malwareScanStatus: 'pending',
        attempts: 0,
      });
      const document = await SourceDocumentModel.findById(response.body.documentId).lean();
      expect(document?.mimeType).toBe(item.mimeType);
      expect(await storage.get(document!.fileKey)).toEqual(item.file);
      expect(
        await DocumentProcessingJobModel.findOne({ sourceDocumentId: document?._id }),
      ).toMatchObject({ status: 'queued', malwareScanStatus: 'pending' });
    }

    expect(await DocumentEvidenceModel.countDocuments()).toBe(0);
    const { RatePackageModel } = await import('../rate-sheets/rate-sheet.models.js');
    expect(await RatePackageModel.countDocuments()).toBe(0);
    const legacyList = await request(app)
      .get('/api/v1/admin/source-documents')
      .set('Cookie', jar.header());
    expect(legacyList.body.total).toBe(0);
    const legacyDetail = await request(app)
      .get(`/api/v1/admin/source-documents/${(await SourceDocumentModel.findOne())?.id}`)
      .set('Cookie', jar.header());
    expect(legacyDetail.status).toBe(404);
  });

  it('ingests unknown files for later unmapped handling and rejects duplicates', async () => {
    const unsupported = await upload(Buffer.from('<html>no</html>'), 'rates.xlsx');
    expect(unsupported.status).toBe(201);
    const unknownDocument = await SourceDocumentModel.findById(unsupported.body.documentId).lean();
    expect(unknownDocument?.mimeType).toBe('application/octet-stream');

    const file = Buffer.from('Header,Rate\nDouble,200');
    const first = await upload(file, 'original.csv');
    const duplicate = await upload(file, 'renamed.csv');

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('duplicate_document');
    expect(await SourceDocumentModel.countDocuments()).toBe(2);
    expect(await DocumentProcessingJobModel.countDocuments()).toBe(2);
  });

  it('bounds concurrent in-memory document uploads', async () => {
    const setup = makeSheetApp({ maxConcurrentDocumentUploads: 1 });
    app = setup.app;
    storage = setup.storage;
    jar = await signInAs(app, await seedUser({ role: 'ops' }));
    let releaseStore!: () => void;
    let signalStoreStarted!: () => void;
    const storeStarted = new Promise<void>((resolve) => {
      signalStoreStarted = resolve;
    });
    const blockedStore = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    const originalPut = storage.put.bind(storage);
    vi.spyOn(storage, 'put').mockImplementation(async (key, data) => {
      signalStoreStarted();
      await blockedStore;
      await originalPut(key, data);
    });

    const firstUpload = upload(Buffer.from('Room,Rate\nDouble,200'), 'first.csv');
    await storeStarted;
    const secondUpload = await upload(Buffer.from('Room,Rate\nQuad,300'), 'second.csv');
    expect(secondUpload.status).toBe(503);
    releaseStore();
    expect((await firstUpload).status).toBe(201);
  });

  it('exposes processing status, paginated evidence, and idempotent retry for staff', async () => {
    const uploaded = await upload(Buffer.from('Room,Rate\nDouble,200'), 'rates.csv');
    const id = uploaded.body.documentId as string;
    const cookie = jar.header();

    const file = await request(app).get(`${INTAKE}/${id}/file`).set('Cookie', cookie);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    const status = await request(app).get(`${INTAKE}/${id}/processing`).set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect(status.body.processing).toMatchObject({
      status: 'queued',
      malwareScanStatus: 'pending',
      attempts: 0,
    });

    const evidence = await request(app)
      .get(`${INTAKE}/${id}/evidence?page=1&limit=10`)
      .set('Cookie', cookie);
    expect(evidence.status).toBe(200);
    expect(evidence.body).toMatchObject({ items: [], page: 1, limit: 10, total: 0 });

    const retry = await request(app).post(`${INTAKE}/${id}/retry`).set('Cookie', cookie);
    expect(retry.status).toBe(202);
    expect(retry.body.processing.id).toBe(uploaded.body.processing.id);
    expect(await DocumentProcessingJobModel.countDocuments()).toBe(1);

    await DocumentProcessingJobModel.updateOne(
      { _id: uploaded.body.processing.id },
      {
        $set: {
          status: 'scan_unavailable',
          malwareScanStatus: 'unavailable',
          attempts: 3,
          finishedAt: new Date(),
        },
      },
    );
    const retried = await request(app).post(`${INTAKE}/${id}/retry`).set('Cookie', cookie);
    expect(retried.status).toBe(202);
    expect(retried.body.processing).toMatchObject({
      id: uploaded.body.processing.id,
      status: 'queued',
      malwareScanStatus: 'pending',
      attempts: 0,
    });

    await DocumentProcessingJobModel.updateOne(
      { _id: uploaded.body.processing.id },
      { $set: { status: 'infected', malwareScanStatus: 'infected' } },
    );
    const quarantinedFile = await request(app).get(`${INTAKE}/${id}/file`).set('Cookie', cookie);
    expect(quarantinedFile.status).toBe(410);
    expect(quarantinedFile.body.error.code).toBe('infected_document');
  });

  it('fails closed when the scanner is unavailable and never creates evidence', async () => {
    const uploaded = await upload(fakePdf('must not parse'), 'unscanned.pdf');
    expect(uploaded.status).toBe(201);
    const scanner = {
      scan: vi.fn(async () => ({ status: 'unavailable' as const, code: 'test_offline' })),
    };
    const worker = startDocumentProcessingWorker({
      storage,
      limits: DEFAULT_DOCUMENT_PARSER_LIMITS,
      scanner,
      workerId: 'document-intelligence-test-worker',
      timing: {
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
        scanTimeoutMs: 100,
        retryDelayMs: 0,
        pollIntervalMs: 10,
      },
    });

    try {
      let job = await DocumentProcessingJobModel.findById(uploaded.body.processing.id);
      for (let attempt = 0; attempt < 100 && job?.status !== 'scan_unavailable'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        job = await DocumentProcessingJobModel.findById(uploaded.body.processing.id);
      }
      expect(job).toMatchObject({
        status: 'scan_unavailable',
        malwareScanStatus: 'unavailable',
        attempts: 3,
      });
      expect(scanner.scan).toHaveBeenCalledTimes(3);
      expect(await DocumentEvidenceModel.countDocuments()).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  it('stores clear warnings when a clean unknown format is retained unmapped', async () => {
    const uploaded = await upload(Buffer.from('unknown file bytes'), 'supplier.tiff');
    expect(uploaded.status).toBe(201);
    const scanner = { scan: vi.fn(async () => ({ status: 'clean' as const })) };
    const worker = startDocumentProcessingWorker({
      storage,
      limits: DEFAULT_DOCUMENT_PARSER_LIMITS,
      scanner,
      workerId: 'document-intelligence-unknown-test-worker',
      timing: {
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
        scanTimeoutMs: 100,
        retryDelayMs: 0,
        pollIntervalMs: 10,
      },
    });

    try {
      let job = await DocumentProcessingJobModel.findById(uploaded.body.processing.id);
      for (let attempt = 0; attempt < 100 && job?.status !== 'unmapped'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        job = await DocumentProcessingJobModel.findById(uploaded.body.processing.id);
      }
      expect(job).toMatchObject({
        status: 'unmapped',
        malwareScanStatus: 'clean',
      });
      expect(job?.processingWarnings.join(' ')).toMatch(/no parser is configured/i);
      expect(scanner.scan).toHaveBeenCalledTimes(1);
      expect(await DocumentEvidenceModel.countDocuments()).toBe(0);
      const status = await request(app)
        .get(`${INTAKE}/${uploaded.body.documentId}/processing`)
        .set('Cookie', jar.header());
      expect(status.body.processing.processingWarnings.join(' ')).toMatch(
        /no parser is configured/i,
      );
    } finally {
      await worker.stop();
    }
  });
});
