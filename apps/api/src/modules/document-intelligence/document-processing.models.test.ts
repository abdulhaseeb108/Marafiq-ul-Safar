import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { DocumentProcessingJobModel } from './document-processing.models.js';

describe('document processing job model', () => {
  const jobFields = () => ({
    sourceDocumentId: new mongoose.Types.ObjectId(),
    idempotencyKey: `${new mongoose.Types.ObjectId()}:sha256:p4a-v1`,
    pipelineVersion: 'p4a-v1',
  });

  it('creates a queued job with pending malware scan and retry defaults', async () => {
    const job = await DocumentProcessingJobModel.create(jobFields());

    expect(job.status).toBe('queued');
    expect(job.malwareScanStatus).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.nextAttemptAt).toBeInstanceOf(Date);
    expect(job.processingWarnings).toEqual([]);
  });

  it('enforces unique idempotency keys', async () => {
    const fields = jobFields();
    await DocumentProcessingJobModel.create(fields);

    await expect(DocumentProcessingJobModel.create(fields)).rejects.toMatchObject({ code: 11000 });
  });

  it('declares an index for document status and retry lookups', () => {
    expect(DocumentProcessingJobModel.schema.indexes()).toContainEqual([
      { sourceDocumentId: 1 },
      expect.any(Object),
    ]);
  });

  it('rejects statuses outside the explicit processing lifecycle', async () => {
    const job = new DocumentProcessingJobModel({ ...jobFields(), status: 'published' });

    await expect(job.validate()).rejects.toThrow(/`published` is not a valid enum value/);
  });
});
