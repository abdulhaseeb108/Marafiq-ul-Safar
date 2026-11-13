import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentProcessingJobModel } from './document-processing.models.js';
import { runWithProcessingLease } from './document-processing.execution.js';
import { claimNextDocumentJob, enqueueDocumentJob } from './document-processing.queue.js';

const LEASE_MS = 1_000;
const EvidenceWriteTestModel =
  mongoose.models.DocumentProcessingEvidenceWriteTest ??
  mongoose.model(
    'DocumentProcessingEvidenceWriteTest',
    new mongoose.Schema(
      { idempotencyKey: { type: String, required: true } },
      { collection: 'documentProcessingEvidenceWriteTests' },
    ),
  );

async function claimedJob() {
  const created = await enqueueDocumentJob({
    sourceDocumentId: new mongoose.Types.ObjectId(),
    idempotencyKey: `execution:${new mongoose.Types.ObjectId()}`,
    pipelineVersion: 'p4a-v1',
  });
  const job = await claimNextDocumentJob('execution-test-worker', {
    leaseDurationMs: LEASE_MS,
  });
  if (!job) throw new Error('Expected to claim the execution test job.');
  expect(String(job._id)).toBe(String(created._id));
  await DocumentProcessingJobModel.updateOne(
    { _id: job._id },
    { $set: { status: 'parsing', malwareScanStatus: 'clean' } },
  );
  return job;
}

describe('document processing execution context', () => {
  beforeEach(async () => {
    await DocumentProcessingJobModel.deleteMany({});
  });

  it('renews the lease while work is active', async () => {
    const job = await claimedJob();
    const initialExpiry = job.lease?.expiresAt?.getTime() as number;

    await runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId as string,
        leaseToken: job.lease?.token as string,
        pipelineVersion: job.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return undefined;
      },
    );

    const updated = await DocumentProcessingJobModel.findById(job._id).lean();
    expect(updated?.lease?.heartbeatAt?.getTime()).toBeGreaterThan(
      job.lease?.heartbeatAt?.getTime() as number,
    );
    expect(updated?.lease?.expiresAt?.getTime()).toBeGreaterThan(initialExpiry);
  });

  it('aborts work and rejects evidence writes when a heartbeat loses the lease', async () => {
    const job = await claimedJob();
    let parsingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      parsingStarted = resolve;
    });
    const evidenceWrite = vi.fn(async () => 'written');
    let lateWriteRejected!: (error: unknown) => void;
    const lateWrite = new Promise<unknown>((resolve) => {
      lateWriteRejected = resolve;
    });

    const execution = runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId as string,
        leaseToken: job.lease?.token as string,
        pipelineVersion: job.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => {
        parsingStarted();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        try {
          await context.writeEvidence('page:1:table:0', evidenceWrite);
          lateWriteRejected(new Error('Unexpected successful evidence write'));
        } catch (error) {
          lateWriteRejected(error);
        }
      },
    );
    // Listen for the rejection before awaiting anything else: on a busy machine the
    // 10 ms heartbeat can see the replaced token, and the execution can reject,
    // before this test resumes after its own update below.
    const executionRejected = expect(execution).rejects.toMatchObject({
      name: 'ProcessingLeaseLostError',
    });
    await started;
    await DocumentProcessingJobModel.updateOne(
      { _id: job._id },
      { $set: { 'lease.token': 'replacement-token' } },
    );

    await executionRejected;
    await expect(lateWrite).resolves.toMatchObject({ name: 'ProcessingLeaseLostError' });
    expect(evidenceWrite).not.toHaveBeenCalled();
  });

  it('fails closed and aborts work when the heartbeat operation errors', async () => {
    const job = await claimedJob();
    const originalUpdateOne = DocumentProcessingJobModel.updateOne.bind(DocumentProcessingJobModel);
    const updateOne = vi
      .spyOn(DocumentProcessingJobModel, 'updateOne')
      .mockImplementationOnce((...args) => originalUpdateOne(...args))
      .mockRejectedValueOnce(new Error('MongoDB heartbeat failure'));
    let started!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execution = runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId as string,
        leaseToken: job.lease?.token as string,
        pipelineVersion: job.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => {
        started();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );
    // Listen before awaiting: the failed heartbeat may reject the execution first.
    const executionRejected = expect(execution).rejects.toMatchObject({
      name: 'ProcessingLeaseLostError',
    });
    await workStarted;

    await executionRejected;
    expect(updateOne).toHaveBeenCalled();
    updateOne.mockRestore();
  });

  it('aborts promptly when a heartbeat operation does not settle', async () => {
    const job = await claimedJob();
    const originalUpdateOne = DocumentProcessingJobModel.updateOne.bind(DocumentProcessingJobModel);
    const updateOne = vi
      .spyOn(DocumentProcessingJobModel, 'updateOne')
      .mockImplementationOnce((...args) => originalUpdateOne(...args))
      .mockImplementationOnce(() => new Promise(() => undefined) as never);
    let started!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execution = runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId as string,
        leaseToken: job.lease?.token as string,
        pipelineVersion: job.pipelineVersion,
      },
      {
        leaseDurationMs: LEASE_MS,
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 25,
      },
      async (context) => {
        started();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );
    // Listen before awaiting: the stalled heartbeat may reject the execution first.
    const executionRejected = expect(execution).rejects.toMatchObject({
      name: 'ProcessingLeaseLostError',
    });
    await workStarted;

    const beganAt = Date.now();
    await executionRejected;
    expect(Date.now() - beganAt).toBeLessThan(500);
    updateOne.mockRestore();
  });

  it('rejects stale worker lease identities before starting work', async () => {
    const job = await claimedJob();
    const work = vi.fn();

    await expect(
      runWithProcessingLease(
        {
          jobId: job.id,
          runId: job.activeRunId as string,
          leaseToken: 'stale-token',
          pipelineVersion: job.pipelineVersion,
        },
        { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
        work,
      ),
    ).rejects.toMatchObject({ name: 'ProcessingLeaseLostError' });
    expect(work).not.toHaveBeenCalled();
  });

  it('uses the same evidence idempotency key across execution retries', async () => {
    const job = await claimedJob();
    const lease = {
      jobId: job.id,
      runId: job.activeRunId as string,
      leaseToken: job.lease?.token as string,
      pipelineVersion: job.pipelineVersion,
    };
    const first = await runWithProcessingLease(
      lease,
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => context.evidenceIdempotencyKey('pdf:page:2:table:1:row:4'),
    );

    await DocumentProcessingJobModel.updateOne(
      { _id: job._id },
      { $set: { status: 'queued' }, $unset: { lease: 1 } },
    );
    const retry = await claimNextDocumentJob('retry-worker', {
      leaseDurationMs: LEASE_MS,
    });
    expect(retry).not.toBeNull();

    const second = await runWithProcessingLease(
      {
        jobId: retry?.id as string,
        runId: retry?.activeRunId as string,
        leaseToken: retry?.lease?.token as string,
        pipelineVersion: retry?.pipelineVersion as string,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => context.evidenceIdempotencyKey('pdf:page:2:table:1:row:4'),
    );

    expect(second).toBe(first);
  });

  it('separates evidence idempotency keys across documents and evidence items', async () => {
    const firstJob = await claimedJob();
    const secondJob = await claimedJob();
    const firstKeys = await runWithProcessingLease(
      {
        jobId: firstJob.id,
        runId: firstJob.activeRunId as string,
        leaseToken: firstJob.lease?.token as string,
        pipelineVersion: firstJob.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => [
        context.evidenceIdempotencyKey('pdf:page:1:table:0:row:0'),
        context.evidenceIdempotencyKey('pdf:page:1:table:0:row:1'),
      ],
    );
    const otherDocumentKey = await runWithProcessingLease(
      {
        jobId: secondJob.id,
        runId: secondJob.activeRunId as string,
        leaseToken: secondJob.lease?.token as string,
        pipelineVersion: secondJob.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => context.evidenceIdempotencyKey('pdf:page:1:table:0:row:0'),
    );
    const delimiterLeft = await runWithProcessingLease(
      {
        jobId: firstJob.id,
        runId: firstJob.activeRunId as string,
        leaseToken: firstJob.lease?.token as string,
        pipelineVersion: `${firstJob.pipelineVersion}\0x`,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => context.evidenceIdempotencyKey('y'),
    );
    const delimiterRight = await runWithProcessingLease(
      {
        jobId: firstJob.id,
        runId: firstJob.activeRunId as string,
        leaseToken: firstJob.lease?.token as string,
        pipelineVersion: firstJob.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => context.evidenceIdempotencyKey('x\0y'),
    );

    expect(new Set(firstKeys).size).toBe(2);
    expect(otherDocumentKey).not.toBe(firstKeys[0]);
    expect(delimiterLeft).not.toBe(delimiterRight);
  });

  it('aborts in-flight guarded writes when failed work ignores its signal', async () => {
    const job = await claimedJob();
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let releaseWrite!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let pendingWrite!: Promise<string>;
    const execution = runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId as string,
        leaseToken: job.lease?.token as string,
        pipelineVersion: job.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => {
        pendingWrite = context.writeEvidence(
          'pdf:page:1:table:0:row:0',
          async (idempotencyKey, _signal, session) => {
            await new EvidenceWriteTestModel({ idempotencyKey }).save({ session });
            writeStarted();
            await release;
            return 'written';
          },
        );
        await started;
        throw new Error('processing failed');
      },
    );

    await expect(execution).rejects.toThrow('processing failed');
    releaseWrite();
    await expect(pendingWrite).rejects.toMatchObject({ name: 'ProcessingLeaseLostError' });
    await expect(EvidenceWriteTestModel.countDocuments({})).resolves.toBe(0);
  });

  it('aborts a guarded transaction that outlives its lease budget', async () => {
    const job = await claimedJob();
    let releaseWrite!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let pendingWrite!: Promise<string>;
    const execution = runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId as string,
        leaseToken: job.lease?.token as string,
        pipelineVersion: job.pipelineVersion,
      },
      { leaseDurationMs: 100, heartbeatIntervalMs: 10 },
      async (context) => {
        pendingWrite = context.writeEvidence(
          'pdf:page:2:table:0:row:0',
          async (idempotencyKey, _signal, session) => {
            await new EvidenceWriteTestModel({ idempotencyKey }).save({ session });
            await release;
            return 'written';
          },
        );
        await pendingWrite;
      },
    );

    // The writer holds its transaction open until released, so the guarded
    // transaction always outlives the 90 ms budget (100 ms lease - 10 ms heartbeat).
    // Do not wait for the writer to start: on a busy machine the budget can expire
    // during the in-transaction ownership check, the writer is then (correctly)
    // never invoked, and waiting for it would hang until the test timeout.
    await expect(execution).rejects.toMatchObject({ name: 'ProcessingLeaseLostError' });
    releaseWrite();
    await expect(pendingWrite).rejects.toMatchObject({ name: 'ProcessingLeaseLostError' });
    await expect(EvidenceWriteTestModel.countDocuments({})).resolves.toBe(0);
  });

  it('rejects evidence identity collisions without invoking the writer after cancellation', async () => {
    const job = await claimedJob();
    const write = vi.fn(async () => 'written');
    await runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId as string,
        leaseToken: job.lease?.token as string,
        pipelineVersion: job.pipelineVersion,
      },
      { leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
      async (context) => {
        expect(() => context.evidenceIdempotencyKey('')).toThrow(/source identity is required/);
        await context.stopRenewal();
        await expect(context.writeEvidence('pdf:page:1', write)).rejects.toMatchObject({
          name: 'ProcessingLeaseLostError',
        });
      },
    );
    expect(write).not.toHaveBeenCalled();
  });
});
