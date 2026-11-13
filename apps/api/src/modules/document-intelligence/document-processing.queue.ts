import { randomUUID } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';
import {
  MalwareScanRejectedError,
  type MalwareScanInput,
  type MalwareScanner,
  parseOnlyIfClean,
} from '../../adapters/malware-scanning/scanner.js';
import {
  DOCUMENT_PROCESSING_STATUSES,
  DocumentProcessingJobModel,
  type DocumentProcessingJobDoc,
} from './document-processing.models.js';
import {
  ProcessingLeaseLostError,
  runWithProcessingLease,
  type ProcessingExecutionContext,
} from './document-processing.execution.js';

type JobStatus = (typeof DOCUMENT_PROCESSING_STATUSES)[number];
type JobId = string | Types.ObjectId;
type ClaimedJob = DocumentProcessingJobDoc;
type ProcessedStatus = 'processed' | 'partial' | 'unmapped';
type FailureStage = 'scan' | 'parse';

const TERMINAL_STATUSES = new Set<JobStatus>([
  'processed',
  'partial',
  'unmapped',
  'scan_unavailable',
  'failed',
  'infected',
]);

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['scanning'],
  scanning: ['parsing', 'scan_unavailable', 'queued', 'failed', 'infected'],
  scan_unavailable: ['queued', 'failed'],
  parsing: ['processed', 'partial', 'unmapped', 'queued', 'failed'],
  processed: [],
  partial: [],
  unmapped: [],
  failed: ['queued'],
  infected: [],
};

export class JobLeaseLostError extends Error {
  constructor() {
    super('The document-processing job lease is no longer owned by this worker.');
    this.name = 'JobLeaseLostError';
  }
}

export class InvalidJobTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid document-processing job transition: ${from} -> ${to}.`);
    this.name = 'InvalidJobTransitionError';
  }
}

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super(
      'The idempotency key is already associated with a different document or pipeline version.',
    );
    this.name = 'IdempotencyKeyConflictError';
  }
}

export interface EnqueueDocumentJobInput {
  sourceDocumentId: JobId;
  idempotencyKey: string;
  pipelineVersion: string;
  maxAttempts?: number;
  now?: Date;
}

export interface ClaimJobOptions {
  now?: Date;
  leaseDurationMs: number;
}

export interface QueueRetryOptions {
  now?: Date;
  retryDelayMs?: number;
}

function validateProcessingWarnings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((warning) => typeof warning !== 'string' || warning.length > 500)
  ) {
    throw new TypeError('Processing warnings must be at most 100 strings of 500 characters.');
  }
  return value;
}

function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidJobTransitionError(from, to);
}

function assertDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function objectId(id: JobId): Types.ObjectId {
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.isValidObjectId(id)) throw new TypeError('Invalid document-processing job id.');
  return new mongoose.Types.ObjectId(id);
}

/** Insert once per idempotency key; concurrent duplicate requests return the same job. */
export async function enqueueDocumentJob(input: EnqueueDocumentJobInput): Promise<ClaimedJob> {
  const now = input.now ?? new Date();
  const maxAttempts = input.maxAttempts ?? 3;
  const sourceDocumentId = objectId(input.sourceDocumentId);
  if (!input.idempotencyKey.trim()) throw new TypeError('An idempotency key is required.');
  if (!input.pipelineVersion.trim()) throw new TypeError('A pipeline version is required.');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw new RangeError('maxAttempts must be a positive safe integer.');

  const assertSameIdentity = (job: ClaimedJob): ClaimedJob => {
    if (
      String(job.sourceDocumentId) !== String(sourceDocumentId) ||
      job.pipelineVersion !== input.pipelineVersion
    ) {
      throw new IdempotencyKeyConflictError();
    }
    return job;
  };

  try {
    const job = await DocumentProcessingJobModel.findOneAndUpdate(
      { idempotencyKey: input.idempotencyKey },
      {
        $setOnInsert: {
          sourceDocumentId,
          idempotencyKey: input.idempotencyKey,
          pipelineVersion: input.pipelineVersion,
          maxAttempts,
          nextAttemptAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    if (!job) throw new Error('MongoDB did not return the enqueued document-processing job.');
    return assertSameIdentity(job);
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
    const existing = await DocumentProcessingJobModel.findOne({
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) return assertSameIdentity(existing);
    throw error;
  }
}

/** Atomically claims only due queued jobs that have attempts remaining. */
export async function claimNextDocumentJob(
  workerId: string,
  options: ClaimJobOptions,
): Promise<ClaimedJob | null> {
  assertDuration(options.leaseDurationMs, 'leaseDurationMs');
  if (!workerId.trim()) throw new TypeError('workerId is required.');
  const now = options.now ?? new Date();
  const token = randomUUID();
  assertTransition('queued', 'scanning');

  return DocumentProcessingJobModel.findOneAndUpdate(
    {
      status: 'queued',
      nextAttemptAt: { $lte: now },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    },
    {
      $set: {
        status: 'scanning',
        malwareScanStatus: 'pending',
        processingWarnings: [],
        lease: {
          workerId,
          token,
          heartbeatAt: now,
          expiresAt: new Date(now.getTime() + options.leaseDurationMs),
        },
        activeRunId: randomUUID(),
      },
      $inc: { attempts: 1 },
      $unset: { lastFailure: 1, finishedAt: 1 },
    },
    { returnDocument: 'after', sort: { nextAttemptAt: 1, createdAt: 1 } },
  );
}

/** Extends a live lease; an expired or superseded lease cannot be revived. */
export async function heartbeatDocumentJob(
  jobId: JobId,
  leaseToken: string,
  options: ClaimJobOptions,
): Promise<boolean> {
  assertDuration(options.leaseDurationMs, 'leaseDurationMs');
  const now = options.now ?? new Date();
  const updated = await DocumentProcessingJobModel.updateOne(
    {
      _id: objectId(jobId),
      status: { $in: ['scanning', 'parsing'] },
      'lease.token': leaseToken,
      'lease.expiresAt': { $gt: now },
    },
    {
      $set: {
        'lease.heartbeatAt': now,
        'lease.expiresAt': new Date(now.getTime() + options.leaseDurationMs),
      },
    },
  );
  return updated.matchedCount === 1;
}

interface FailureInput {
  stage: FailureStage;
  code: string;
  message: string;
  malwareScanStatus?: 'unavailable' | 'error';
}

/** Records a retryable failure, or finalizes the job once its attempt budget is exhausted. */
export async function failClaimedDocumentJob(
  jobId: JobId,
  leaseToken: string,
  failure: FailureInput,
  options: QueueRetryOptions = {},
): Promise<JobStatus> {
  const now = options.now ?? new Date();
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0)
    throw new RangeError('retryDelayMs must be a non-negative safe integer.');

  const job = await DocumentProcessingJobModel.findOne({
    _id: objectId(jobId),
    status: { $in: ['scanning', 'parsing'] },
    'lease.token': leaseToken,
    'lease.expiresAt': { $gt: now },
  }).select('status attempts maxAttempts');
  if (!job) throw new JobLeaseLostError();

  const retry = job.attempts < job.maxAttempts;
  const nextStatus: JobStatus = retry
    ? 'queued'
    : failure.stage === 'scan' && failure.malwareScanStatus === 'unavailable'
      ? 'scan_unavailable'
      : 'failed';
  assertTransition(job.status as JobStatus, nextStatus);
  const set: Record<string, unknown> = {
    status: nextStatus,
    lastFailure: { stage: failure.stage, code: failure.code, message: failure.message },
  };
  if (failure.malwareScanStatus) set.malwareScanStatus = failure.malwareScanStatus;
  if (retry) {
    set.nextAttemptAt = new Date(now.getTime() + retryDelayMs);
    if (!failure.malwareScanStatus) set.malwareScanStatus = 'pending';
  } else {
    set.finishedAt = now;
  }

  const updated = await DocumentProcessingJobModel.updateOne(
    {
      _id: job._id,
      status: job.status,
      'lease.token': leaseToken,
      'lease.expiresAt': { $gt: now },
      attempts: job.attempts,
    },
    { $set: set, $unset: { lease: 1 } },
  );
  if (updated.matchedCount !== 1) throw new JobLeaseLostError();
  return nextStatus;
}

export interface RecoverExpiredLeasesOptions {
  now?: Date;
  retryDelayMs?: number;
  batchSize?: number;
}

/** Returns expired scanning/parsing leases to the queue, or fails exhausted jobs. */
export async function recoverExpiredDocumentJobs(
  options: RecoverExpiredLeasesOptions = {},
): Promise<{ requeued: number; failed: number }> {
  const now = options.now ?? new Date();
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0)
    throw new RangeError('retryDelayMs must be a non-negative safe integer.');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new RangeError('batchSize must be a positive safe integer.');

  const expired = await DocumentProcessingJobModel.find({
    status: { $in: ['scanning', 'parsing'] },
    'lease.expiresAt': { $lte: now },
  })
    .select('_id status attempts maxAttempts lease.token')
    .sort({ 'lease.expiresAt': 1 })
    .limit(batchSize)
    .lean();

  let requeued = 0;
  let failed = 0;
  for (const job of expired) {
    const from = job.status as JobStatus;
    const retry = job.attempts < job.maxAttempts;
    const to: JobStatus = retry ? 'queued' : 'failed';
    assertTransition(from, to);
    const set: Record<string, unknown> = {
      status: to,
      lastFailure: {
        stage: from === 'scanning' ? 'scan' : 'parse',
        code: 'lease_expired',
        message: 'Worker lease expired before the processing attempt completed.',
      },
    };
    if (retry) {
      set.nextAttemptAt = new Date(now.getTime() + retryDelayMs);
      set.malwareScanStatus = 'pending';
    } else {
      set.finishedAt = now;
    }

    const result = await DocumentProcessingJobModel.updateOne(
      {
        _id: job._id,
        status: from,
        'lease.token': job.lease?.token,
        'lease.expiresAt': { $lte: now },
        attempts: job.attempts,
      },
      { $set: set, $unset: { lease: 1 } },
    );
    if (result.matchedCount !== 1) continue;
    if (retry) requeued += 1;
    else failed += 1;
  }
  return { requeued, failed };
}

function assertTerminalStatus(status: ProcessedStatus): void {
  if (!TERMINAL_STATUSES.has(status)) throw new TypeError('Invalid processing result status.');
}

/** Scans, atomically enters parsing, then invokes parsing exactly once for the lease. */
export async function processClaimedDocumentJob<T>(
  jobId: JobId,
  leaseToken: string,
  scanner: MalwareScanner,
  input: Omit<MalwareScanInput, 'signal'>,
  options: QueueRetryOptions & {
    scanTimeoutMs: number;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
  },
  parse: (context: ProcessingExecutionContext) => Promise<{
    status: ProcessedStatus;
    value: T;
    warnings?: string[];
  }>,
): Promise<T> {
  try {
    const now = new Date();
    const job = await DocumentProcessingJobModel.findOne({
      _id: objectId(jobId),
      status: 'scanning',
      'lease.token': leaseToken,
      'lease.expiresAt': { $gt: now },
      activeRunId: { $type: 'string' },
    }).select('activeRunId pipelineVersion');
    if (!job?.activeRunId) throw new JobLeaseLostError();

    return await runWithProcessingLease(
      {
        jobId: job.id,
        runId: job.activeRunId,
        leaseToken,
        pipelineVersion: job.pipelineVersion,
      },
      {
        leaseDurationMs: options.leaseDurationMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
      },
      async (context) =>
        parseOnlyIfClean(scanner, input, options.scanTimeoutMs, async () => {
          context.assertActive();
          assertTransition('scanning', 'parsing');
          const transition = await DocumentProcessingJobModel.updateOne(
            {
              _id: objectId(jobId),
              activeRunId: context.runId,
              status: 'scanning',
              'lease.token': leaseToken,
              'lease.expiresAt': { $gt: new Date() },
            },
            { $set: { status: 'parsing', malwareScanStatus: 'clean' } },
          );
          if (transition.matchedCount !== 1) throw new JobLeaseLostError();

          let parsed: { status: ProcessedStatus; value: T; warnings?: string[] };
          try {
            parsed = await parse(context);
          } catch (error) {
            if (error instanceof ProcessingLeaseLostError) throw error;
            await context.stopRenewal({ abortWork: true });
            await failClaimedDocumentJob(
              jobId,
              leaseToken,
              { stage: 'parse', code: 'parse_failed', message: 'Document parsing failed.' },
              { now: new Date(), retryDelayMs: options.retryDelayMs },
            );
            throw error;
          }

          context.assertActive();
          assertTerminalStatus(parsed.status);
          assertTransition('parsing', parsed.status);
          const processingWarnings = validateProcessingWarnings(parsed.warnings ?? []);
          await context.stopRenewal();
          const completedAt = new Date();
          const completed = await DocumentProcessingJobModel.updateOne(
            {
              _id: objectId(jobId),
              activeRunId: context.runId,
              status: 'parsing',
              'lease.token': leaseToken,
              'lease.expiresAt': { $gt: completedAt },
            },
            {
              $set: {
                status: parsed.status,
                malwareScanStatus: 'clean',
                processingWarnings,
                finishedAt: completedAt,
              },
              $unset: { lease: 1 },
            },
          );
          if (completed.matchedCount !== 1) throw new JobLeaseLostError();
          return parsed.value;
        }),
    );
  } catch (error) {
    if (error instanceof ProcessingLeaseLostError) throw new JobLeaseLostError();
    if (error instanceof MalwareScanRejectedError) {
      const { result } = error;
      if (result.status === 'infected') {
        assertTransition('scanning', 'infected');
        const infectedAt = new Date();
        const update = await DocumentProcessingJobModel.updateOne(
          {
            _id: objectId(jobId),
            status: 'scanning',
            'lease.token': leaseToken,
            'lease.expiresAt': { $gt: infectedAt },
          },
          {
            $set: {
              status: 'infected',
              malwareScanStatus: 'infected',
              lastFailure: {
                stage: 'scan',
                code: 'infected',
                message: result.signature ?? 'The malware scanner marked this document infected.',
              },
              finishedAt: infectedAt,
            },
            $unset: { lease: 1 },
          },
        );
        if (update.matchedCount !== 1) throw new JobLeaseLostError();
        throw error;
      }

      const malwareScanStatus = result.status === 'unavailable' ? 'unavailable' : 'error';
      await failClaimedDocumentJob(
        jobId,
        leaseToken,
        {
          stage: 'scan',
          code: result.code,
          message: 'Malware scanning did not produce a clean verdict.',
          malwareScanStatus,
        },
        { now: new Date(), retryDelayMs: options.retryDelayMs },
      );
    } else if (!(error instanceof JobLeaseLostError)) {
      const current = await DocumentProcessingJobModel.findOne({
        _id: objectId(jobId),
        status: 'scanning',
        'lease.token': leaseToken,
      }).select('_id');
      if (current) {
        await failClaimedDocumentJob(
          jobId,
          leaseToken,
          { stage: 'scan', code: 'scan_gate_failed', message: 'Malware scanning failed.' },
          { now: new Date(), retryDelayMs: options.retryDelayMs },
        );
      }
    }
    throw error;
  }
}
