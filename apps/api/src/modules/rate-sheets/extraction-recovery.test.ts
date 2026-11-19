/**
 * A reading interrupted by a restart must not leave a sheet "extracting" for
 * ever: after the stale period it shows the normal failure message, and staff
 * can retry (documents.service.ts, recoverStaleExtractions).
 */
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '../../lib/actor.js';
import { AuditEventModel } from '../audit/audit.model.js';
import { EXTRACTION_FAILED_MESSAGE, recoverStaleExtractions } from './documents.service.js';
import { SourceDocumentModel } from './rate-sheet.models.js';

const MINUTE = 60 * 1000;
const now = new Date('2026-11-18T12:00:00Z');

const sheet = (fields: Record<string, unknown>) =>
  SourceDocumentModel.create({
    supplierId: new Types.ObjectId(),
    fileKey: `rate-sheets/${new Types.ObjectId().toString()}.pdf`,
    fileName: 'sheet.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    sha256: new Types.ObjectId().toString(),
    receivedAt: now,
    ...fields,
  });

describe('recovering readings interrupted by a restart', () => {
  it('marks a reading older than 10 minutes as failed, with an audit event', async () => {
    const stuck = await sheet({
      extractionStatus: 'extracting',
      extractionStartedAt: new Date(now.getTime() - 11 * MINUTE),
    });
    expect(await recoverStaleExtractions(SYSTEM_ACTOR, now)).toBe(1);

    const after = await SourceDocumentModel.findById(stuck._id).lean();
    expect(after?.extractionStatus).toBe('needs_review');
    expect(after?.extractionError).toBe(EXTRACTION_FAILED_MESSAGE);
    const audit = await AuditEventModel.findOne({ entityId: stuck._id }).lean();
    expect(audit?.action).toBe('sourceDocument.extract_failed');
    expect(audit?.actorRole).toBe('system');
    expect(audit?.after).toEqual({ failure: 'interrupted' });
  });

  it('leaves a reading that is still within its time alone', async () => {
    const live = await sheet({
      extractionStatus: 'extracting',
      extractionStartedAt: new Date(now.getTime() - 2 * MINUTE),
    });
    expect(await recoverStaleExtractions(SYSTEM_ACTOR, now)).toBe(0);
    expect((await SourceDocumentModel.findById(live._id).lean())?.extractionStatus).toBe(
      'extracting',
    );
  });

  it('touches nothing that is not extracting, and is safe to run again', async () => {
    const done = await sheet({
      extractionStatus: 'needs_review',
      extractionStartedAt: new Date(now.getTime() - 60 * MINUTE),
    });
    const stuck = await sheet({ extractionStatus: 'extracting' }); // no start time recorded
    expect(await recoverStaleExtractions(SYSTEM_ACTOR, now)).toBe(1);
    expect(await recoverStaleExtractions(SYSTEM_ACTOR, now)).toBe(0);
    expect((await SourceDocumentModel.findById(done._id).lean())?.extractionError).toBeUndefined();
    expect((await SourceDocumentModel.findById(stuck._id).lean())?.extractionStatus).toBe(
      'needs_review',
    );
    expect(await AuditEventModel.countDocuments({ action: 'sourceDocument.extract_failed' })).toBe(
      1,
    );
  });
});
