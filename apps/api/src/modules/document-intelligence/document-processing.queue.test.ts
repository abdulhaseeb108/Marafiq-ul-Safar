import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MalwareScanner } from '../../adapters/malware-scanning/scanner.js';
import { DocumentProcessingJobModel } from './document-processing.models.js';
import {
  claimNextDocumentJob,
  enqueueDocumentJob,
  failClaimedDocumentJob,
  heartbeatDocumentJob,
  IdempotencyKeyConflictError,
  JobLeaseLostError,
  processClaimedDocumentJob,
  recoverExpiredDocumentJobs,
} from './document-processing.queue.js';

const LEASE_MS = 60_000;
const SCAN_INPUT = {
  data: Buffer.from('document bytes'),
  fileName: 'supplier.pdf',
  mimeType: 'application/pdf',
};

async function enqueue(maxAttempts = 3) {
  return enqueueDocumentJob({
    sourceDocumentId: new mongoose.Types.ObjectId(),
    idempotencyKey: `doc:${new mongoose.Types.ObjectId()}:p4a-v1`,
    pipelineVersion: 'p4a-v1',
    maxAttempts,
  });
}

async function claim(workerId = 'worker-a', now = new Date()) {
  const job = await claimNextDocumentJob(workerId, { now, leaseDurationMs: LEASE_MS });
  if (!job) throw new Error('Expected a queued job to be claimed.');
  return job;
}

describe('document processing MongoDB queue', () => {
  beforeEach(async () => {
    await DocumentProcessingJobModel.deleteMany({});
  });

  it('atomically permits only one concurrent worker to claim a queued job', async () => {
    const queued = await enqueue();
    const now = new Date();
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        claimNextDocumentJob(`worker-${index}`, { now, leaseDurationMs: LEASE_MS }),
      ),
    );
    const winners = claims.filter((job) => job !== null);

    expect(winners).toHaveLength(1);
    expect(String(winners[0]?._id)).toBe(String(queued._id));
    expect(winners[0]?.attempts).toBe(1);
    expect(winners[0]?.status).toBe('scanning');
  });

  it('claims only due queued jobs with attempts remaining', async () => {
    const future = new Date(Date.now() + 60_000);
    const deferred = await enqueue();
    await DocumentProcessingJobModel.updateOne(
      { _id: deferred._id },
      { $set: { nextAttemptAt: future } },
    );
    expect(
      await claimNextDocumentJob('early-worker', {
        now: new Date(future.getTime() - 1),
        leaseDurationMs: LEASE_MS,
      }),
    ).toBeNull();

    const exhausted = await enqueue(1);
    const first = await claim('worker-a', new Date());
    await failClaimedDocumentJob(
      first._id,
      first.lease?.token as string,
      { stage: 'scan', code: 'offline', message: 'Unavailable' },
      { retryDelayMs: 0 },
    );
    expect(String(first._id)).toBe(String(exhausted._id));

    const claimed = await claimNextDocumentJob('worker-c', {
      now: new Date(future.getTime() - 1),
      leaseDurationMs: LEASE_MS,
    });
    expect(claimed).toBeNull();
    expect(await DocumentProcessingJobModel.findById(exhausted._id).select('status')).toMatchObject(
      {
        status: 'failed',
      },
    );
  });

  it('extends only the current unexpired lease and rejects stale tokens', async () => {
    const job = await enqueue();
    const now = new Date();
    const claimed = await claim('worker-a', now);
    const token = claimed.lease?.token as string;
    const extendedAt = new Date(now.getTime() + 10_000);

    await expect(
      heartbeatDocumentJob(job._id, 'stale-token', {
        now: extendedAt,
        leaseDurationMs: LEASE_MS,
      }),
    ).resolves.toBe(false);
    await expect(
      heartbeatDocumentJob(job._id, token, { now: extendedAt, leaseDurationMs: LEASE_MS }),
    ).resolves.toBe(true);

    const updated = await DocumentProcessingJobModel.findById(job._id).lean();
    expect(updated?.lease?.heartbeatAt?.getTime()).toBe(extendedAt.getTime());
    expect(updated?.lease?.expiresAt?.getTime()).toBe(extendedAt.getTime() + LEASE_MS);
  });

  it('prevents a stale lease token from requeuing or failing a job', async () => {
    await enqueue();
    const claimed = await claim();

    await expect(
      failClaimedDocumentJob(claimed._id, 'stale-token', {
        stage: 'scan',
        code: 'offline',
        message: 'Unavailable',
      }),
    ).rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(
      DocumentProcessingJobModel.findById(claimed._id).select('status attempts'),
    ).resolves.toMatchObject({ status: 'scanning', attempts: 1 });
  });

  it('recovers expired leases and refuses late heartbeats', async () => {
    await enqueue();
    const now = new Date();
    const claimed = await claim('worker-a', now);
    const expiredAt = new Date(now.getTime() - 1);
    await DocumentProcessingJobModel.updateOne(
      { _id: claimed._id },
      { $set: { 'lease.expiresAt': expiredAt, status: 'parsing', malwareScanStatus: 'clean' } },
    );

    await expect(
      heartbeatDocumentJob(claimed._id, claimed.lease?.token as string, {
        now,
        leaseDurationMs: LEASE_MS,
      }),
    ).resolves.toBe(false);
    await expect(recoverExpiredDocumentJobs({ now, retryDelayMs: 0 })).resolves.toEqual({
      requeued: 1,
      failed: 0,
    });

    const recovered = await DocumentProcessingJobModel.findById(claimed._id).lean();
    expect(recovered).toMatchObject({
      status: 'queued',
      malwareScanStatus: 'pending',
      attempts: 1,
      lastFailure: { code: 'lease_expired' },
    });
    expect(recovered?.lease?.token).toBeUndefined();
    expect(
      await claimNextDocumentJob('worker-b', { now, leaseDurationMs: LEASE_MS }),
    ).not.toBeNull();
  });

  it('marks an expired job failed when its attempt budget is exhausted', async () => {
    await enqueue(1);
    const now = new Date();
    const claimed = await claim('worker-a', now);
    await DocumentProcessingJobModel.updateOne(
      { _id: claimed._id },
      { $set: { 'lease.expiresAt': new Date(now.getTime() - 1) } },
    );

    await expect(recoverExpiredDocumentJobs({ now })).resolves.toEqual({ requeued: 0, failed: 1 });
    await expect(
      DocumentProcessingJobModel.findById(claimed._id).select('status attempts'),
    ).resolves.toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('retries within the bound, schedules nextAttemptAt, then fails at the limit', async () => {
    const queued = await enqueue(2);
    const initial = new Date();
    const first = await claim('worker-a', initial);
    const firstToken = first.lease?.token as string;
    const retryAt = new Date(initial.getTime() + 5_000);

    await expect(
      failClaimedDocumentJob(
        first._id,
        firstToken,
        {
          stage: 'scan',
          code: 'scanner_offline',
          message: 'Unavailable',
          malwareScanStatus: 'unavailable',
        },
        { now: initial, retryDelayMs: 5_000 },
      ),
    ).resolves.toBe('queued');
    const scheduled = await DocumentProcessingJobModel.findById(queued._id).lean();
    expect(scheduled?.nextAttemptAt.getTime()).toBe(retryAt.getTime());
    expect(scheduled?.malwareScanStatus).toBe('unavailable');
    expect(
      await claimNextDocumentJob('early-worker', { now: initial, leaseDurationMs: LEASE_MS }),
    ).toBeNull();

    const second = await claim('worker-b', retryAt);
    await expect(
      failClaimedDocumentJob(
        second._id,
        second.lease?.token as string,
        {
          stage: 'scan',
          code: 'scanner_offline',
          message: 'Unavailable',
          malwareScanStatus: 'unavailable',
        },
        { now: retryAt, retryDelayMs: 0 },
      ),
    ).resolves.toBe('scan_unavailable');
    await expect(
      claimNextDocumentJob('worker-c', {
        now: new Date(Date.now() + LEASE_MS),
        leaseDurationMs: LEASE_MS,
      }),
    ).resolves.toBeNull();
    await expect(
      DocumentProcessingJobModel.findById(queued._id).select('status malwareScanStatus'),
    ).resolves.toMatchObject({ status: 'scan_unavailable', malwareScanStatus: 'unavailable' });
  });

  it('does not parse infected or unavailable documents', async () => {
    const infectedJob = await enqueue();
    const infectedClaim = await claim();
    const infectedParse = vi.fn();
    const infectedScanner: MalwareScanner = {
      scan: async () => ({ status: 'infected', signature: 'test-signature' }),
    };

    await expect(
      processClaimedDocumentJob(
        infectedJob._id,
        infectedClaim.lease?.token as string,
        infectedScanner,
        SCAN_INPUT,
        { scanTimeoutMs: 100, leaseDurationMs: LEASE_MS, heartbeatIntervalMs: 10 },
        async () => {
          infectedParse();
          return { status: 'processed', value: undefined };
        },
      ),
    ).rejects.toMatchObject({ result: { status: 'infected' } });
    expect(infectedParse).not.toHaveBeenCalled();
    await expect(
      DocumentProcessingJobModel.findById(infectedJob._id).select('status malwareScanStatus'),
    ).resolves.toMatchObject({ status: 'infected', malwareScanStatus: 'infected' });

    const unavailableJob = await enqueue();
    const unavailableClaim = await claim();
    const parse = vi.fn();
    await expect(
      processClaimedDocumentJob(
        unavailableJob._id,
        unavailableClaim.lease?.token as string,
        { scan: async () => ({ status: 'unavailable', code: 'scanner_offline' }) },
        SCAN_INPUT,
        {
          scanTimeoutMs: 100,
          leaseDurationMs: LEASE_MS,
          heartbeatIntervalMs: 10,
          retryDelayMs: 0,
        },
        async () => {
          parse();
          return { status: 'processed', value: undefined };
        },
      ),
    ).rejects.toMatchObject({ result: { status: 'unavailable' } });
    expect(parse).not.toHaveBeenCalled();
    await expect(
      DocumentProcessingJobModel.findById(unavailableJob._id).select('status lastFailure'),
    ).resolves.toMatchObject({
      status: 'queued',
      lastFailure: { stage: 'scan', code: 'scanner_offline' },
    });
  });

  it('enters parsing only after a clean verdict and prevents duplicate processing', async () => {
    const job = await enqueue();
    const claimed = await claim();
    let releaseScans: (() => void) | undefined;
    const scanBarrier = new Promise<void>((resolve) => {
      releaseScans = resolve;
    });
    let scans = 0;
    const scanner: MalwareScanner = {
      scan: async () => {
        scans += 1;
        if (scans === 2) releaseScans?.();
        await scanBarrier;
        return { status: 'clean' };
      },
    };
    const parse = vi.fn(async () => ({ status: 'processed' as const, value: 'evidence' }));
    const options = {
      scanTimeoutMs: 1_000,
      leaseDurationMs: LEASE_MS,
      heartbeatIntervalMs: 10,
    };
    const token = claimed.lease?.token as string;
    const outcomes = await Promise.allSettled([
      processClaimedDocumentJob(job._id, token, scanner, SCAN_INPUT, options, parse),
      processClaimedDocumentJob(job._id, token, scanner, SCAN_INPUT, options, parse),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(parse).toHaveBeenCalledOnce();
    await expect(
      DocumentProcessingJobModel.findById(job._id).select('status malwareScanStatus'),
    ).resolves.toMatchObject({ status: 'processed', malwareScanStatus: 'clean' });
  });

  it('aborts the processing signal when parsing fails before scheduling a retry', async () => {
    const job = await enqueue();
    const claimed = await claim();
    let processingSignal: AbortSignal | undefined;

    await expect(
      processClaimedDocumentJob(
        job._id,
        claimed.lease?.token as string,
        { scan: async () => ({ status: 'clean' }) },
        SCAN_INPUT,
        {
          scanTimeoutMs: 100,
          leaseDurationMs: LEASE_MS,
          heartbeatIntervalMs: 10,
          retryDelayMs: 0,
        },
        async (context) => {
          processingSignal = context.signal;
          throw new Error('test parse failure');
        },
      ),
    ).rejects.toThrow('test parse failure');

    expect(processingSignal?.aborted).toBe(true);
    await expect(
      DocumentProcessingJobModel.findById(job._id).select('status attempts'),
    ).resolves.toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('returns the existing job for duplicate idempotency keys', async () => {
    const input = {
      sourceDocumentId: new mongoose.Types.ObjectId(),
      idempotencyKey: `stable:${new mongoose.Types.ObjectId()}`,
      pipelineVersion: 'p4a-v1',
    };
    const first = await enqueueDocumentJob(input);
    const duplicate = await enqueueDocumentJob(input);

    expect(String(duplicate._id)).toBe(String(first._id));
    expect(
      await DocumentProcessingJobModel.countDocuments({ idempotencyKey: input.idempotencyKey }),
    ).toBe(1);
  });

  it('rejects reusing an idempotency key for another document', async () => {
    const input = {
      sourceDocumentId: new mongoose.Types.ObjectId(),
      idempotencyKey: `stable:${new mongoose.Types.ObjectId()}`,
      pipelineVersion: 'p4a-v1',
    };
    await enqueueDocumentJob(input);

    await expect(
      enqueueDocumentJob({ ...input, sourceDocumentId: new mongoose.Types.ObjectId() }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });
});
