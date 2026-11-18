/**
 * Regression tests for duplicate rate-sheet detection (docs/03 section 2.1,
 * test case T9). "The same document" means the same bytes for the same
 * supplier; the file name plays no part.
 */
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoryStorage } from '../../adapters/storage/storage.js';
import {
  CookieJar,
  fakePdf,
  makeSheetApp,
  seedSupplier,
  seedUser,
  signInAs,
  uploadSheet,
} from '../../test/helpers.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { RatePackageModel, SourceDocumentModel } from './rate-sheet.models.js';

const DOCS = '/api/v1/admin/source-documents';

let app: Express;
let jar: CookieJar;
let storage: MemoryStorage;
let supplierId: string;

beforeEach(async () => {
  ({ app, storage } = makeSheetApp());
  jar = await signInAs(app, await seedUser({ role: 'ops' }));
  supplierId = (await seedSupplier({ name: 'Waqar-e-Madina Group (WMT)' })).id;
});

describe('duplicate rate-sheet upload', () => {
  it('1. rejects the same PDF uploaded twice for the same supplier', async () => {
    const content = fakePdf('ramadan 2027');
    const first = await uploadSheet(app, jar, {
      supplierId,
      content,
      fileName: 'WMT RAMADAN 2027.pdf',
    });
    const second = await uploadSheet(app, jar, {
      supplierId,
      content,
      fileName: 'WMT RAMADAN 2027.pdf',
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('duplicate_document');
    expect(await SourceDocumentModel.countDocuments()).toBe(1);
    expect(await RatePackageModel.countDocuments()).toBe(0);
    expect(await AuditEventModel.countDocuments({ action: 'sourceDocument.upload' })).toBe(1);
  });

  it('2. rejects the same content under a different file name', async () => {
    const content = fakePdf('ramadan 2027');
    const first = await uploadSheet(app, jar, {
      supplierId,
      content,
      fileName: 'WMT RAMADAN 2027.pdf',
    });
    const second = await uploadSheet(app, jar, {
      supplierId,
      content,
      fileName: 'WMT RAMADAN 2027 (1).pdf', // a browser's second download of the same file
    });

    expect(second.status).toBe(409);
    expect(second.body.error.fields.existingId).toBe(first.body.id);
    expect(await SourceDocumentModel.countDocuments()).toBe(1);
  });

  it('3. accepts a different PDF for the same supplier', async () => {
    await uploadSheet(app, jar, { supplierId, content: fakePdf('ramadan 2027') });
    const other = await uploadSheet(app, jar, {
      supplierId,
      content: fakePdf('group packages'),
      fileName: 'UMRAH GROUP PACKAGES ISB.pdf',
    });
    expect(other.status).toBe(201);
    expect(await SourceDocumentModel.countDocuments({ supplierId })).toBe(2);
  });

  it('even one changed byte is a different document', async () => {
    const original = fakePdf('ramadan 2027');
    const edited = Buffer.from(original);
    edited[edited.length - 2] = (edited[edited.length - 2] ?? 0) ^ 1;
    await uploadSheet(app, jar, { supplierId, content: original });
    expect((await uploadSheet(app, jar, { supplierId, content: edited })).status).toBe(201);
  });

  it('4. accepts the same PDF for a different supplier', async () => {
    const content = fakePdf('shared sheet');
    await uploadSheet(app, jar, { supplierId, content });
    const other = await seedSupplier({ name: 'Another Operator' });
    const res = await uploadSheet(app, jar, { supplierId: other.id, content });

    expect(res.status).toBe(201);
    expect(await SourceDocumentModel.countDocuments()).toBe(2);
    // And a second copy for that supplier is still caught.
    expect((await uploadSheet(app, jar, { supplierId: other.id, content })).status).toBe(409);
  });

  it('5. lets only one of several simultaneous uploads of the same file through', async () => {
    const content = fakePdf('race');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => uploadSheet(app, jar, { supplierId, content })),
    );
    const statuses = results.map((res) => res.status).sort();

    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await SourceDocumentModel.countDocuments()).toBe(1);
    const winner = results.find((res) => res.status === 201);
    for (const loser of results.filter((res) => res.status === 409)) {
      expect(loser.body.error.code).toBe('duplicate_document');
      expect(loser.body.error.fields.existingId).toBe(winner?.body.id);
    }
  });

  it('says which document already exists, so the screen can link to it', async () => {
    const content = fakePdf('ramadan 2027');
    const first = await uploadSheet(app, jar, {
      supplierId,
      content,
      fileName: 'WMT RAMADAN 2027.pdf',
    });
    const second = await uploadSheet(app, jar, { supplierId, content, fileName: 'copy.pdf' });

    expect(second.body.error.fields).toEqual({
      existingId: first.body.id,
      existingFileName: 'WMT RAMADAN 2027.pdf',
      existingReceivedAt: first.body.receivedAt,
    });
  });

  it('still detects the duplicate after the first document was read, entered or rejected', async () => {
    const content = fakePdf('ramadan 2027');
    const first = await uploadSheet(app, jar, { supplierId, content });
    const pack = await request(app)
      .post(`${DOCS}/${first.body.id}/rate-packages`)
      .set('Cookie', jar.header())
      .send({ packName: 'WMT RAMADAN' });
    await request(app)
      .post(`/api/v1/admin/rate-packages/${pack.body.id}/reject`)
      .set('Cookie', jar.header())
      .send({});

    const again = await uploadSheet(app, jar, { supplierId, content });
    expect(again.status).toBe(409);
    expect(again.body.error.fields.existingId).toBe(first.body.id);
  });

  it('stores the file once', async () => {
    const content = fakePdf('ramadan 2027');
    await uploadSheet(app, jar, { supplierId, content });
    await uploadSheet(app, jar, { supplierId, content });
    const docs = await SourceDocumentModel.find().lean();
    expect(docs).toHaveLength(1);
    expect(await storage.get(docs[0]!.fileKey)).toEqual(content);
  });
});

describe('entering the same pack by hand twice', () => {
  it('refuses a second pack with the same name on one document, pointing at the first', async () => {
    const uploaded = await uploadSheet(app, jar, {
      supplierId,
      content: fakePdf('group packages'),
    });
    const create = (packName: string) =>
      request(app)
        .post(`${DOCS}/${uploaded.body.id}/rate-packages`)
        .set('Cookie', jar.header())
        .send({ packName });

    const first = await create('UMRAH GROUP PACKAGES ISB');
    expect(first.status).toBe(201);

    for (const name of [
      'UMRAH GROUP PACKAGES ISB',
      'umrah group  packages isb',
      'UMRAH GROUP PACKAGES ISB.',
    ]) {
      const again = await create(name);
      expect(again.status, name).toBe(409);
      expect(again.body.error.code).toBe('pack_name_taken');
      expect(again.body.error.fields.existingId).toBe(first.body.id);
    }
    expect(await RatePackageModel.countDocuments()).toBe(1);

    // A differently named pack on the same sheet is normal: one PDF holds several.
    expect((await create('Ramadan Pack 02')).status).toBe(201);
  });

  it('allows the name again once the earlier pack was rejected', async () => {
    const uploaded = await uploadSheet(app, jar, {
      supplierId,
      content: fakePdf('group packages'),
    });
    const url = `${DOCS}/${uploaded.body.id}/rate-packages`;
    const first = await request(app)
      .post(url)
      .set('Cookie', jar.header())
      .send({ packName: 'Pack A' });
    await request(app)
      .post(`/api/v1/admin/rate-packages/${first.body.id}/reject`)
      .set('Cookie', jar.header())
      .send({});
    const second = await request(app)
      .post(url)
      .set('Cookie', jar.header())
      .send({ packName: 'Pack A' });
    expect(second.status).toBe(201);
  });
});
