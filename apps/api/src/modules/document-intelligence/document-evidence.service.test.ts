import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceDocumentModel } from '../rate-sheets/rate-sheet.models.js';
import { DocumentEvidenceModel } from './document-evidence.models.js';
import {
  DocumentEvidenceIntegrityError,
  persistDocumentEvidence,
} from './document-evidence.service.js';
import { DocumentProcessingJobModel } from './document-processing.models.js';
import {
  ProcessingLeaseLostError,
  runWithProcessingLease,
  type ProcessingExecutionContext,
} from './document-processing.execution.js';

const LEASE_MS = 60_000;

async function sourceDocument() {
  return SourceDocumentModel.create({
    supplierId: new mongoose.Types.ObjectId(),
    fileKey: `rate-sheets/test/${new mongoose.Types.ObjectId()}.pdf`,
    fileName: 'supplier.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 16,
    sha256: 'a'.repeat(64),
    receivedAt: new Date(),
    extractionStatus: 'uploaded',
  });
}

async function parsingJob(sourceDocumentId: mongoose.Types.ObjectId) {
  const runId = new mongoose.Types.ObjectId().toString();
  const leaseToken = new mongoose.Types.ObjectId().toString();
  const job = await DocumentProcessingJobModel.create({
    sourceDocumentId,
    idempotencyKey: `evidence:${new mongoose.Types.ObjectId()}`,
    pipelineVersion: 'p4a-v1',
    status: 'parsing',
    malwareScanStatus: 'clean',
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAt: new Date(),
    activeRunId: runId,
    lease: {
      workerId: 'evidence-test',
      token: leaseToken,
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + LEASE_MS),
    },
  });
  return { job, runId, leaseToken };
}

async function withContext<T>(
  job: Awaited<ReturnType<typeof parsingJob>>['job'],
  runId: string,
  leaseToken: string,
  work: (context: ProcessingExecutionContext) => Promise<T>,
): Promise<T> {
  return runWithProcessingLease(
    {
      jobId: job.id,
      runId,
      leaseToken,
      pipelineVersion: job.pipelineVersion,
    },
    { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 20_000 },
    work,
  );
}

const pdfEvidence = (page = 1, content = 'Printed source text') => ({
  kind: 'pdf_text' as const,
  location: { page },
  content,
  metadata: { parser: 'pdfjs', version: 'p4a-v1' },
});

describe('document evidence persistence', () => {
  beforeEach(async () => {
    await DocumentEvidenceModel.deleteMany({});
    await DocumentProcessingJobModel.deleteMany({});
    await SourceDocumentModel.deleteMany({});
  });

  it('persists validated evidence only as unreviewed and preserves provenance', async () => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);

    const saved = await withContext(job, runId, leaseToken, (context) =>
      persistDocumentEvidence(context, source.id, pdfEvidence(3)),
    );

    expect(saved).toMatchObject({
      sourceDocumentId: source._id,
      processingJobId: job._id,
      kind: 'pdf_text',
      location: { page: 3 },
      content: 'Printed source text',
      reviewStatus: 'unreviewed',
    });
  });

  it('deduplicates identical evidence writes and rejects identity reuse for changed content', async () => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);

    await withContext(job, runId, leaseToken, async (context) => {
      const first = await persistDocumentEvidence(context, source.id, pdfEvidence());
      const retry = await persistDocumentEvidence(context, source.id, pdfEvidence());
      expect(String(retry._id)).toBe(String(first._id));
      await expect(
        persistDocumentEvidence(context, source.id, pdfEvidence(1, 'different text')),
      ).rejects.toBeInstanceOf(DocumentEvidenceIntegrityError);
    });

    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(1);
  });

  it('keeps the evidence key stable across processing retries', async () => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);
    const first = await withContext(job, runId, leaseToken, (context) =>
      persistDocumentEvidence(context, source.id, pdfEvidence()),
    );
    const retryRunId = new mongoose.Types.ObjectId().toString();
    const retryLeaseToken = new mongoose.Types.ObjectId().toString();
    await DocumentProcessingJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          activeRunId: retryRunId,
          'lease.token': retryLeaseToken,
          'lease.expiresAt': new Date(Date.now() + LEASE_MS),
        },
      },
    );
    const retry = await withContext(job, retryRunId, retryLeaseToken, (context) =>
      persistDocumentEvidence(context, source.id, pdfEvidence()),
    );

    expect(String(retry._id)).toBe(String(first._id));
    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(1);
  });

  it('stores multiple evidence items from distinct source locations', async () => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);

    await withContext(job, runId, leaseToken, async (context) => {
      await persistDocumentEvidence(context, source.id, pdfEvidence(1));
      await persistDocumentEvidence(context, source.id, pdfEvidence(2, 'Second page'));
    });

    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(2);
  });

  it('rejects invalid source ids and nonexistent source documents', async () => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);
    const missingId = new mongoose.Types.ObjectId().toString();

    await withContext(job, runId, leaseToken, async (context) => {
      await expect(
        persistDocumentEvidence(context, 'not-an-object-id', pdfEvidence()),
      ).rejects.toThrow(/Invalid source document id/);
      await expect(persistDocumentEvidence(context, missingId, pdfEvidence())).rejects.toThrow(
        /Source document does not exist/,
      );
    });

    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(0);
  });

  it('rejects a source document that does not own the active processing job', async () => {
    const source = await sourceDocument();
    const otherSource = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);

    await withContext(job, runId, leaseToken, (context) =>
      persistDocumentEvidence(context, otherSource.id, pdfEvidence()),
    ).then(
      () => {
        throw new Error('Expected source-document/job mismatch to be rejected.');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(DocumentEvidenceIntegrityError);
      },
    );
    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(0);
  });

  it.each([
    ['scan is not clean', { malwareScanStatus: 'error' }],
    ['job is not parsing', { status: 'scanning' }],
  ])('fails closed when %s', async (_label, change) => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);
    await DocumentProcessingJobModel.updateOne({ _id: job._id }, { $set: change });

    await expect(
      withContext(job, runId, leaseToken, (context) =>
        persistDocumentEvidence(context, source.id, pdfEvidence()),
      ),
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(0);
  });

  it('rejects stale leases, expired leases and missing active runs', async () => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);
    await expect(
      withContext(job, runId, 'stale-token', (context) =>
        persistDocumentEvidence(context, source.id, pdfEvidence()),
      ),
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);

    await DocumentProcessingJobModel.updateOne(
      { _id: job._id },
      { $set: { 'lease.expiresAt': new Date(Date.now() - 1) } },
    );
    await expect(
      withContext(job, runId, leaseToken, (context) =>
        persistDocumentEvidence(context, source.id, pdfEvidence()),
      ),
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);

    await DocumentProcessingJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          activeRunId: '',
          'lease.expiresAt': new Date(Date.now() + LEASE_MS),
        },
      },
    );
    await expect(
      withContext(job, runId, leaseToken, (context) =>
        persistDocumentEvidence(context, source.id, pdfEvidence()),
      ),
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(0);
  });

  it('rolls back the lease touch when evidence insertion fails inside the transaction', async () => {
    const source = await sourceDocument();
    const { job, runId, leaseToken } = await parsingJob(source._id);
    const updateOne = vi.spyOn(DocumentProcessingJobModel, 'updateOne');
    const evidenceWrite = vi
      .spyOn(DocumentEvidenceModel, 'findOneAndUpdate')
      .mockRejectedValue(new Error('simulated evidence persistence failure'));

    await expect(
      withContext(job, runId, leaseToken, (context) =>
        persistDocumentEvidence(context, source.id, pdfEvidence()),
      ),
    ).rejects.toThrow('simulated evidence persistence failure');

    expect(updateOne.mock.calls.some(([, , options]) => Boolean(options?.session))).toBe(true);
    await expect(DocumentEvidenceModel.countDocuments()).resolves.toBe(0);
    evidenceWrite.mockRestore();
    updateOne.mockRestore();
  });
});
